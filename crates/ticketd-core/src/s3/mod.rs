//! Workspace sync storage in an S3 bucket (ADR 0018). This module holds how ticketd gets
//! credentials: from the person's AWS CLI v2 profile, never from a secret of its own.
mod aws_cli;
pub use aws_cli::{
    AwsCli, AwsCliError, Credentials, ProfileAccess, ProfileCredentials, ProfileSettings,
    SignInCommand,
};
