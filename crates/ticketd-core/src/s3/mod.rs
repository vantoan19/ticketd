//! Workspace sync storage in an S3 bucket (ADR 0018). This module holds how ticketd gets
//! credentials (from the person's AWS CLI v2 profile, never from a secret of its own), the
//! signed client, and the storage adapter.
mod aws_cli;
mod bucket_check;
mod client;
mod provider;
mod remote;
mod xml;
pub use aws_cli::{
    AwsCli, AwsCliError, Credentials, ProfileAccess, ProfileCredentials, ProfileSettings,
    SignInCommand,
};
pub use bucket_check::{BucketCheckError, discover_bucket_region};
pub use client::{S3Call, S3Client, cli_failure, refusal};
pub use provider::{
    CredentialSource, S3Request, S3Response, S3Target, S3TargetError, S3Transport,
    S3TransportError, UreqS3Transport,
};
pub use remote::{S3Remote, SINGLE_PART_LIMIT, checked_prefix};
