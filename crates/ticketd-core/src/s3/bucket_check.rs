//! The check before the first sync with a bucket (ADR 0018): it must have Versioning on,
//! refuse a second create of an object, and let the profile read, write and list what sync
//! needs. Each way it can fail is its own error, worded as what to fix.
//!
//! The check leaves one small object at `<prefix>.ticketd-bucket-check`. Sync never deletes,
//! so the object stays, and a later check finds it and writes nothing new.
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

use super::client::{S3Call, S3Client, ended_session_on_head, error_of, refusal};
use super::provider::{CredentialSource, S3Response, S3Target, S3Transport};
use super::xml::{versioning_status, versions_page};
use crate::sync::remote::RemoteError;

/// The key of the check's object, after the prefix.
const PROBE: &str = ".ticketd-bucket-check";
const PROBE_BYTES: &[u8] = b"ticketd checked that this bucket can hold a synced Workspace.\n";
/// How often the check repeats a create that S3 answers with 409, a conditional write still
/// in progress.
const ATTEMPTS: u32 = 4;

/// Why a bucket cannot sync a Workspace, or why the check could not finish.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BucketCheckError {
    #[error(
        "the bucket {bucket} does not exist, or the profile's account cannot see it; check the bucket name"
    )]
    MissingBucket { bucket: String },
    #[error(
        "Versioning is {} on this bucket; turn Versioning on in the bucket's properties, because sync keeps each file's History in it",
        if *.suspended { "suspended" } else { "off" }
    )]
    VersioningOff { suspended: bool },
    #[error(
        "this storage let a second create of the same file through; sync needs a bucket that refuses it (conditional writes with If-None-Match), such as one on AWS S3, MinIO or Ceph"
    )]
    NoConditionalWrites,
    #[error(
        "the profile is not allowed to use {action} on this bucket; add it to the profile's policy for the bucket and prefix"
    )]
    PermissionDenied { action: String },
    #[error(
        "the profile cannot use the bucket's encryption key ({detail}); allow kms:GenerateDataKey and kms:Decrypt on the key, or choose a bucket without that key"
    )]
    KmsKeyUnusable { detail: String },
    #[error("{reason}")]
    UnsupportedBucket { reason: String },
    #[error(
        "S3 returned other bytes than the check stored; the storage does not keep files faithfully, so sync cannot use it"
    )]
    ReadBackMismatch,
    /// The storage could not be reached or refused for a reason that is not the bucket's:
    /// sign-in ended, offline, throttled.
    #[error(transparent)]
    Storage(#[from] RemoteError),
}

impl From<BucketCheckError> for RemoteError {
    fn from(error: BucketCheckError) -> Self {
        match error {
            BucketCheckError::Storage(error) => error,
            other => RemoteError::Other(other.to_string()),
        }
    }
}

/// The S3 permission each step uses, for naming it when S3 does not.
const LIST_BUCKET: &str = "s3:ListBucket";
const GET_VERSIONING: &str = "s3:GetBucketVersioning";
const PUT_OBJECT: &str = "s3:PutObject";
const GET_OBJECT: &str = "s3:GetObject";
const GET_OBJECT_VERSION: &str = "s3:GetObjectVersion";
const LIST_VERSIONS: &str = "s3:ListBucketVersions";

/// Runs the whole check: a failure is the first thing wrong.
pub(super) fn run(client: &S3Client<'_>, prefix: &str) -> Result<(), BucketCheckError> {
    // Directory buckets are named like this, and have no Versioning.
    if client.target().bucket().ends_with("--x-s3") {
        return Err(BucketCheckError::UnsupportedBucket {
            reason: "this is an S3 directory bucket, which has no Versioning; choose a general purpose bucket".into(),
        });
    }
    let head = client.send(&head_bucket())?;
    if !(200..300).contains(&head.status) {
        return Err(head_failure(client.target(), &head));
    }
    versioning_is_on(client)?;
    let probe = format!("{prefix}{PROBE}");
    refuses_a_second_create(client, &probe)?;
    read_back(client, &probe, None, GET_OBJECT)?;
    let version = newest_version(client, &probe)?;
    read_back(client, &probe, Some(&version), GET_OBJECT_VERSION)
}

fn head_bucket() -> S3Call<'static> {
    S3Call {
        method: "HEAD",
        key: "",
        query: &[],
        headers: &[],
        body: &[],
    }
}

/// A HEAD answer has no body, so only its status says what went wrong.
fn head_failure(target: &S3Target, head: &S3Response) -> BucketCheckError {
    // S3 names the bucket's region in every answer, including a refusal.
    if ended_session_on_head("HEAD", head) {
        return BucketCheckError::Storage(RemoteError::Unauthorized);
    }
    let elsewhere = head
        .header("x-amz-bucket-region")
        .filter(|region| *region != target.region());
    match (head.status, elsewhere) {
        (404, _) => BucketCheckError::MissingBucket {
            bucket: target.bucket().to_owned(),
        },
        (301 | 307 | 400 | 403, Some(region)) => {
            BucketCheckError::Storage(RemoteError::Other(format!(
                "the bucket is in the region {region}, not {}; choose the bucket again",
                target.region()
            )))
        }
        (403, None) => BucketCheckError::PermissionDenied {
            action: LIST_BUCKET.into(),
        },
        _ => BucketCheckError::Storage(refusal(head)),
    }
}

/// What a refusal means for the bucket, when `action` is what the step was doing.
fn failure(target: &S3Target, response: &S3Response, action: &str) -> BucketCheckError {
    let general = refusal(response);
    if !matches!(general, RemoteError::Other(_)) {
        return match general {
            RemoteError::FolderMissing => BucketCheckError::MissingBucket {
                bucket: target.bucket().to_owned(),
            },
            other => BucketCheckError::Storage(other),
        };
    }
    let error = error_of(response).unwrap_or_default();
    let message: String = error.message.chars().take(300).collect();
    if error.code.starts_with("KMS.") || message.to_ascii_lowercase().contains("kms") {
        return BucketCheckError::KmsKeyUnusable { detail: message };
    }
    if response.status == 403 && matches!(error.code.as_str(), "AccessDenied" | "AllAccessDisabled")
    {
        return BucketCheckError::PermissionDenied {
            action: named_action(&message).unwrap_or(action).to_owned(),
        };
    }
    if response.status == 501 || error.code == "NotImplemented" {
        return BucketCheckError::UnsupportedBucket {
            reason: format!("this storage does not support {action}, which sync needs"),
        };
    }
    BucketCheckError::Storage(general)
}

/// The action AWS names in an access denied message: "…is not authorized to perform:
/// s3:PutObject on resource…".
fn named_action(message: &str) -> Option<&str> {
    let action = message
        .split_once("perform: ")?
        .1
        .split_whitespace()
        .next()?
        .trim_end_matches([',', '.']);
    let valid = action
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'*' | b'-' | b'_'));
    (action.contains(':') && valid).then_some(action)
}

fn versioning_is_on(client: &S3Client<'_>) -> Result<(), BucketCheckError> {
    let response = client.send(&S3Call::get("", &[("versioning", "")]))?;
    if response.status != 200 {
        return Err(failure(client.target(), &response, GET_VERSIONING));
    }
    let status = versioning_status(&response.body).ok_or_else(|| {
        BucketCheckError::Storage(RemoteError::Other(
            "S3 returned an unreadable answer about Versioning".into(),
        ))
    })?;
    match status.as_deref() {
        Some("Enabled") => Ok(()),
        Some("Suspended") => Err(BucketCheckError::VersioningOff { suspended: true }),
        _ => Err(BucketCheckError::VersioningOff { suspended: false }),
    }
}

enum Created {
    New,
    AlreadyThere,
}

fn create_probe(client: &S3Client<'_>, key: &str) -> Result<Created, BucketCheckError> {
    let headers = [
        ("content-type", "text/plain; charset=utf-8".to_owned()),
        ("if-none-match", "*".to_owned()),
        (
            "x-amz-checksum-sha256",
            STANDARD.encode(Sha256::digest(PROBE_BYTES)),
        ),
    ];
    for attempt in 0..ATTEMPTS {
        let response = client.send(&S3Call {
            method: "PUT",
            key,
            query: &[],
            headers: &headers,
            body: PROBE_BYTES,
        })?;
        match response.status {
            200 => return Ok(Created::New),
            412 => return Ok(Created::AlreadyThere),
            409 => client.wait(std::time::Duration::from_millis(100 << attempt)),
            501 => return Err(BucketCheckError::NoConditionalWrites),
            _ => return Err(failure(client.target(), &response, PUT_OBJECT)),
        }
    }
    Err(BucketCheckError::Storage(RemoteError::Other(
        "S3 kept refusing the check's file because another write was in progress; try again".into(),
    )))
}

/// A bucket that honours `If-None-Match: *` refuses the second create. When the check's file
/// is there from an earlier check, the first create already is the second.
fn refuses_a_second_create(client: &S3Client<'_>, key: &str) -> Result<(), BucketCheckError> {
    match create_probe(client, key)? {
        Created::AlreadyThere => Ok(()),
        Created::New => match create_probe(client, key)? {
            Created::AlreadyThere => Ok(()),
            Created::New => Err(BucketCheckError::NoConditionalWrites),
        },
    }
}

/// Reads the file, as sync's downloads do, and compares it and its SHA-256 with what was stored.
fn read_back(
    client: &S3Client<'_>,
    key: &str,
    version: Option<&str>,
    action: &str,
) -> Result<(), BucketCheckError> {
    let version_query = version.map(|version| [("versionId", version)]);
    let query: &[(&str, &str)] = version_query.as_ref().map_or(&[], |query| query);
    let headers = [("x-amz-checksum-mode", "ENABLED".to_owned())];
    let response = client.send(&S3Call {
        method: "GET",
        key,
        query,
        headers: &headers,
        body: &[],
    })?;
    if response.status != 200 {
        return Err(failure(client.target(), &response, action));
    }
    let checksum_agrees = response
        .header("x-amz-checksum-sha256")
        .is_none_or(|sent| sent == STANDARD.encode(Sha256::digest(&response.body)));
    if response.body == PROBE_BYTES && checksum_agrees {
        Ok(())
    } else {
        Err(BucketCheckError::ReadBackMismatch)
    }
}

/// Lists the versions under the check's key and returns the newest one's id.
fn newest_version(client: &S3Client<'_>, key: &str) -> Result<String, BucketCheckError> {
    let response = client.send(&S3Call::get("", &[("versions", ""), ("prefix", key)]))?;
    if response.status != 200 {
        return Err(failure(client.target(), &response, LIST_VERSIONS));
    }
    let page = versions_page(&response.body).ok_or_else(|| {
        BucketCheckError::Storage(RemoteError::Other(
            "S3 returned an unreadable list of versions".into(),
        ))
    })?;
    page.entries
        .into_iter()
        .find(|entry| entry.key == key && !entry.is_delete_marker())
        .map(|entry| entry.version_id)
        .ok_or_else(|| BucketCheckError::UnsupportedBucket {
            reason: "S3 stored the check's file but did not list it among the bucket's versions; sync needs a bucket with Versioning".into(),
        })
}

/// The region a bucket lives in, from the `x-amz-bucket-region` header of HeadBucket, which
/// S3 sends whichever region the request went to. `probe` is the target to ask through:
/// `us-east-1` for an AWS bucket, whose region is not known yet, and the profile's own region
/// with its endpoint for another service. `transport` must send to `probe`. A service that
/// sends no such header is taken to be in the probe's region. Build the bucket's
/// [`S3Target`] from the answer.
pub fn discover_bucket_region(
    probe: &S3Target,
    credentials: &dyn CredentialSource,
    transport: &dyn S3Transport,
) -> Result<String, BucketCheckError> {
    let client = S3Client::new(probe.clone(), credentials, transport);
    let head = client.send(&head_bucket())?;
    let told = head
        .header("x-amz-bucket-region")
        .filter(|region| !region.is_empty())
        .filter(|region| {
            region
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    match (told, head.status) {
        (Some(region), _) => Ok(region.to_owned()),
        (None, 200..=299) => Ok(probe.region().to_owned()),
        _ => Err(head_failure(probe, &head)),
    }
}
