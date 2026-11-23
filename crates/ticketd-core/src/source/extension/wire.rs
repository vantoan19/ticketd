//! The Contract 2 wire messages. The published schema uses these same types.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::super::{
    ChoiceOption, ConfigValues, ConnectionCheck, Conversation, DiscoveryPage, ErrorClass,
    ExternalIssue, ExternalRef, FieldIssue, PublicationCandidates, PublicationSearch,
    PublishRequest, SourceDescription, SourceError,
};

#[derive(Clone, Copy, Deserialize, Serialize, JsonSchema)]
pub(super) enum JsonRpc {
    #[serde(rename = "2.0")]
    V2,
}

#[derive(Serialize, JsonSchema)]
pub(super) struct Request<'a> {
    pub jsonrpc: JsonRpc,
    pub id: u64,
    #[serde(flatten)]
    pub call: Call<'a>,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub(super) enum Call<'a> {
    Describe {
        contract_versions: &'a [u32],
        pid: u32,
    },
    CheckConnection(ConnectionParams<'a>),
    Validate(ConnectionParams<'a>),
    Options {
        #[serde(flatten)]
        connection: ConnectionParams<'a>,
        field: &'a str,
        query: &'a str,
    },
    Discover {
        #[serde(flatten)]
        connection: ConnectionParams<'a>,
        cursor: Option<&'a str>,
        page_size: usize,
    },
    Fetch(IssueParams<'a>),
    Conversation(IssueParams<'a>),
    Publish {
        #[serde(flatten)]
        connection: ConnectionParams<'a>,
        request: &'a PublishRequest,
    },
    Locate {
        #[serde(flatten)]
        connection: ConnectionParams<'a>,
        destination: &'a str,
        text: &'a str,
    },
    FindPublished {
        #[serde(flatten)]
        connection: ConnectionParams<'a>,
        search: &'a PublicationSearch,
    },
}

#[derive(Clone, Copy, Serialize, JsonSchema)]
pub(super) struct ConnectionParams<'a> {
    pub connection_id: &'a str,
    pub config: &'a ConfigValues,
}

#[derive(Serialize, JsonSchema)]
pub(super) struct IssueParams<'a> {
    #[serde(flatten)]
    pub connection: ConnectionParams<'a>,
    pub reference: &'a ExternalRef,
}

impl<'a> Call<'a> {
    pub(super) fn with_config<'b>(self, configuration: &'b ConfigValues) -> Call<'b>
    where
        'a: 'b,
    {
        let mut call: Call<'b> = self;
        let connection = match &mut call {
            Call::CheckConnection(connection)
            | Call::Validate(connection)
            | Call::Options { connection, .. }
            | Call::Discover { connection, .. }
            | Call::Publish { connection, .. }
            | Call::Locate { connection, .. }
            | Call::FindPublished { connection, .. } => connection,
            Call::Fetch(issue) | Call::Conversation(issue) => &mut issue.connection,
            Call::Describe { .. } => return call,
        };
        connection.config = configuration;
        call
    }
}

#[derive(Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
pub(super) struct Description {
    pub contract_versions: Vec<u32>,
    /// Null when the extension does not support any versions offered by the host.
    pub contract_version: Option<u32>,
    pub version: String,
    pub description: Option<SourceDescription>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(untagged)]
pub(super) enum Response<T> {
    Success(Success<T>),
    Failure(Failure),
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Success<T> {
    pub jsonrpc: JsonRpc,
    pub id: u64,
    pub result: T,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Failure {
    pub jsonrpc: JsonRpc,
    pub id: u64,
    pub error: RpcError,
}

#[derive(Deserialize, JsonSchema)]
pub(super) struct RpcError {
    pub code: i32,
    pub message: String,
    /// Domain errors use code -32000 and carry the source failure in data.
    pub data: Option<WireFailure>,
}

#[derive(Deserialize, JsonSchema)]
pub(super) struct WireFailure {
    pub class: ErrorClass,
    pub code: WireFailureCode,
    pub message: String,
    /// Reserved for diagnostics. The host does not expose extension-supplied detail.
    #[serde(rename = "detail")]
    _detail: Option<String>,
    #[serde(default)]
    pub fields: Vec<FieldIssue>,
    pub retry_after_secs: Option<u64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(super) enum WireFailureCode {
    Unauthenticated,
    Forbidden,
    NotFound,
    RateLimited,
    Unavailable,
    NotSent,
    Rejected,
    Protocol,
    Unsupported,
    InvalidConfiguration,
}

impl RpcError {
    pub(super) fn into_source_error(self, secrets: &super::redaction::Redactions) -> SourceError {
        if let Some(mut failure) = self.data
            && self.code == -32000
        {
            failure.message = secrets.text(&failure.message);
            secrets.fields(&mut failure.fields);
            return failure.into_source_error();
        }
        SourceError::Protocol(format!(
            "JSON-RPC error {}: {}",
            self.code,
            secrets.text(&self.message)
        ))
    }
}

impl WireFailure {
    fn into_source_error(mut self) -> SourceError {
        use WireFailureCode::*;
        let error = match self.code {
            Unauthenticated => SourceError::Unauthenticated(self.message),
            Forbidden => SourceError::Forbidden(self.message),
            NotFound => SourceError::NotFound(self.message),
            RateLimited => SourceError::RateLimited {
                retry_after_secs: self.retry_after_secs,
            },
            Unavailable => SourceError::Unavailable(self.message),
            NotSent => SourceError::NotSent(self.message),
            Rejected => SourceError::Rejected(self.message),
            Protocol => SourceError::Protocol(self.message),
            Unsupported => SourceError::Unsupported("this operation"),
            InvalidConfiguration => {
                if self.fields.is_empty() {
                    self.fields.push(FieldIssue::for_form(self.message));
                }
                SourceError::InvalidConfiguration(self.fields)
            }
        };
        if error.class() == self.class {
            error
        } else {
            SourceError::Protocol("the source error's code and class disagree".into())
        }
    }
}

#[derive(JsonSchema)]
#[serde(untagged)]
#[allow(dead_code)] // A schema-facing union. Each runtime call parses its specific result.
enum ResultValue {
    Describe(Description),
    CheckConnection(ConnectionCheck),
    Validate(Vec<FieldIssue>),
    Options(Vec<ChoiceOption>),
    Discover(DiscoveryPage),
    Issue(ExternalIssue),
    Conversation(Conversation),
    FindPublished(PublicationCandidates),
}

#[derive(JsonSchema)]
#[serde(untagged)]
#[allow(dead_code)] // A schema-facing union of messages exchanged over stdio.
enum Contract2 {
    Host(Request<'static>),
    Extension(Response<ResultValue>),
}

pub(super) fn schema() -> schemars::Schema {
    schemars::generate::SchemaSettings::draft2020_12()
        .for_deserialize()
        .into_generator()
        .into_root_schema_for::<Contract2>()
}
