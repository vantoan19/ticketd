//! The S3 storage of this desktop's S3 binding (ADR 0018). One [`S3Storage`] serves a
//! binding for as long as the app runs, like the one Drive storage. It reaches the bucket
//! through the AWS CLI profile, which needs the CLI to be installed and signed in, so it
//! is put together on first use, not when the Workspace is read. A CLI that is missing or
//! a session that ended is then an error of that call, which sync turns into a state the
//! person sees, and the next call tries again.

use std::{
    path::Path,
    sync::{Arc, Mutex, PoisonError},
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

pub struct S3Storage {
    binding: S3Binding,
    build: Box<Build>,
    built: Mutex<Option<Arc<Built>>>,
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
            built: Mutex::new(None),
        }
    }

    /// The storage ready to use. A failure keeps nothing, so the next call tries again.
    pub fn built(&self) -> Result<Arc<Built>, RemoteError> {
        let mut built = self.built.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(built) = built.as_ref() {
            return Ok(Arc::clone(built));
        }
        let made = Arc::new((self.build)(&self.binding)?);
        *built = Some(Arc::clone(&made));
        Ok(made)
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
        let built = self.built.lock().unwrap_or_else(PoisonError::into_inner);
        Some(service(&built.as_ref()?.target).to_owned())
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
        Some(recorded) if recorded != reached => {
            Err(RemoteError::Other(s3_service_changed(recorded, reached)))
        }
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

        let Err(RemoteError::Other(message)) = storage.folders() else {
            panic!("a profile that reaches another service was used");
        };
        assert!(message.contains("This profile now points to another S3 service"));
        assert!(message.contains("https://minio.example.com:9000"));
        assert!(message.contains("AWS"));
        assert!(message.contains("disconnect sync, then connect again"));
        // Nothing was kept: the profile pointing back works again at the next call.
        assert_eq!(storage.reached(), None);
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
