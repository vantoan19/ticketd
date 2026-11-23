//! The Contract 2 wire messages. The published schema uses these same types.

use std::borrow::Cow;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ChoiceOption, ConfigValues, ConnectionCheck, Conversation, DiscoveryPage, ErrorClass,
    ExternalIssue, ExternalRef, FieldIssue, PublicationCandidates, PublicationSearch,
    PublishRequest, SourceDescription,
};

#[derive(Clone, Copy, Deserialize, Serialize, JsonSchema)]
pub enum JsonRpc {
    #[serde(rename = "2.0")]
    V2,
}

#[derive(Deserialize, Serialize, JsonSchema)]
pub struct Request<'a> {
    pub jsonrpc: JsonRpc,
    pub id: u64,
    #[serde(flatten)]
    pub call: Call<'a>,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum Call<'a> {
    Describe {
        contract_versions: Cow<'a, [u32]>,
        pid: u32,
    },
    CheckConnection(ConnectionParams<'a>),
    Validate(ConnectionParams<'a>),
    Options {
        #[serde(flatten)]
        connection: ConnectionParams<'a>,
        field: Cow<'a, str>,
        query: Cow<'a, str>,
    },
    Discover {
        #[serde(flatten)]
        connection: ConnectionParams<'a>,
        cursor: Option<Cow<'a, str>>,
        page_size: usize,
    },
    Fetch(IssueParams<'a>),
    Conversation(IssueParams<'a>),
    Publish {
        #[serde(flatten)]
        connection: ConnectionParams<'a>,
        request: Cow<'a, PublishRequest>,
    },
    Locate {
        #[serde(flatten)]
        connection: ConnectionParams<'a>,
        destination: Cow<'a, str>,
        text: Cow<'a, str>,
    },
    FindPublished {
        #[serde(flatten)]
        connection: ConnectionParams<'a>,
        search: Cow<'a, PublicationSearch>,
    },
}

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
pub struct ConnectionParams<'a> {
    pub connection_id: Cow<'a, str>,
    pub config: Cow<'a, ConfigValues>,
}

#[derive(Deserialize, Serialize, JsonSchema)]
pub struct IssueParams<'a> {
    #[serde(flatten)]
    pub connection: ConnectionParams<'a>,
    pub reference: Cow<'a, ExternalRef>,
}

impl<'a> Call<'a> {
    pub fn with_config<'b>(self, configuration: &'b ConfigValues) -> Call<'b>
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
        connection.config = Cow::Borrowed(configuration);
        call
    }
}

#[derive(Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
pub struct Description {
    pub contract_versions: Vec<u32>,
    /// Null when the extension does not support any versions offered by the host.
    pub contract_version: Option<u32>,
    pub version: String,
    pub description: Option<SourceDescription>,
}

pub const LINE_LIMIT: usize = 4 * 1024 * 1024;
pub const REQUEST_CANCELED: i32 = -32800;

/// Stop the request identified by params.id and send its terminal error response.
#[derive(Deserialize, Serialize, JsonSchema)]
pub struct CancelNotification {
    pub jsonrpc: JsonRpc,
    pub method: CancelMethod,
    pub params: CancelParams,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CancelMethod {
    Cancel,
}

#[derive(Deserialize, Serialize, JsonSchema)]
pub struct CancelParams {
    pub id: u64,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProgressNotification {
    pub jsonrpc: JsonRpc,
    pub method: ProgressMethod,
    pub params: ProgressParams,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProgressMethod {
    Progress,
}

#[derive(Deserialize, Serialize, JsonSchema)]
pub struct ProgressParams {
    /// ID of the active request, carried in params because this is a notification.
    pub id: u64,
    /// Number of items processed in this request so far.
    pub completed: u32,
    /// Total number of items when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(untagged)]
pub enum Response<T> {
    Success(Success<T>),
    Failure(Failure),
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Success<T> {
    pub jsonrpc: JsonRpc,
    pub id: u64,
    pub result: T,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub jsonrpc: JsonRpc,
    pub id: u64,
    pub error: RpcError,
}

#[derive(Deserialize, Serialize, JsonSchema)]
pub struct RpcError {
    /// Use -32800 for a request stopped by a matching cancel notification.
    pub code: i32,
    pub message: String,
    /// Domain errors use code -32000 and carry the source failure in data.
    pub data: Option<WireFailure>,
}

#[derive(Deserialize, Serialize, JsonSchema)]
pub struct WireFailure {
    pub class: ErrorClass,
    pub code: WireFailureCode,
    pub message: String,
    /// Reserved for diagnostics. The host does not expose extension-supplied detail.
    #[serde(rename = "detail")]
    pub detail: Option<String>,
    #[serde(default)]
    pub fields: Vec<FieldIssue>,
    pub retry_after_secs: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WireFailureCode {
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

#[derive(Serialize, JsonSchema)]
#[serde(untagged)]
pub(crate) enum ResultValue {
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
    Extension(Box<Response<ResultValue>>),
    Progress(ProgressNotification),
    Cancel(CancelNotification),
}

pub fn schema() -> schemars::Schema {
    schemars::generate::SchemaSettings::draft2020_12()
        .for_deserialize()
        .into_generator()
        .into_root_schema_for::<Contract2>()
}
