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
        S3TargetError, S3Transport, UreqS3Transport, discover_bucket_region,
    },
    sync::{
        S3Binding,
        remote::{
            RemoteCapabilities, RemoteContent, RemoteError, RemoteFile, RemoteFolder, RemoteKey,
            RemoteRevision, RemoteStorage,
        },
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
    if error.needs_sign_in() {
        RemoteError::Unauthorized
    } else {
        // The CLI's own words hold no credential.
        RemoteError::Other(error.to_string())
    }
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
}

fn build(binding: &S3Binding) -> Result<Built, RemoteError> {
    let cli = AwsCli::locate(binding.aws_cli_path.as_deref().map(Path::new)).map_err(cli_error)?;
    let settings = cli.settings(&binding.profile).map_err(cli_error)?;
    let other = |error: S3TargetError| RemoteError::Other(error.to_string());
    let endpoint = settings.endpoint_url.as_deref();
    let credentials = Shared(s3_commands::credentials(&cli, &binding.profile));
    // An AWS bucket has a region of its own, which the profile's need not be: ask AWS where
    // it is. Another service has no other region than the profile's.
    let probe_region = match endpoint {
        Some(_) => settings.region.as_deref().unwrap_or("us-east-1"),
        None => "us-east-1",
    };
    let probe = S3Target::new(&binding.bucket, probe_region, endpoint).map_err(other)?;
    let region =
        discover_bucket_region(&probe, &credentials, &UreqS3Transport::new(probe.clone()))?;
    let target = S3Target::new(&binding.bucket, &region, endpoint).map_err(other)?;
    // The adapter borrows what it signs and sends with. One value is built per binding for
    // as long as the app runs, and only a built one gets here, so what is given lives that long.
    let credentials: &'static Shared = Box::leak(Box::new(credentials));
    let transport: &'static dyn S3Transport =
        Box::leak(Box::new(UreqS3Transport::new(target.clone())));
    let remote =
        S3Remote::new(target.clone(), &binding.prefix, credentials, transport).map_err(other)?;
    Ok(Built {
        storage: Arc::new(remote),
        target,
    })
}

static KEPT: Mutex<Option<Arc<S3Storage>>> = Mutex::new(None);

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
    fn the_console_page_needs_the_storage_to_be_reachable() {
        let storage = S3Storage::with_build(binding(), |_| Err(RemoteError::Offline));
        assert_eq!(storage.console_url("f1"), None);
        assert_eq!(storage.address("f1"), "s3://team-bucket/ticketd/f1/");
    }
}
