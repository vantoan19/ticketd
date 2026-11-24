//! The Contract 2 wire messages. The published schema uses these same types.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, transform::RecursiveTransform};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    /// A fixed diagnostic code. Use up to 80 lower-case ASCII letters, digits,
    /// underscores or hyphens. ticketd accepts this field and does not log it.
    pub detail: Option<String>,
    #[serde(default)]
    pub fields: Vec<FieldIssue>,
    pub retry_after_secs: Option<u64>,
}

/// Validate a diagnostic code before sending it.
#[doc(hidden)]
pub fn valid_failure_detail(detail: &str) -> bool {
    !detail.is_empty()
        && detail.len() <= 80
        && detail.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
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
    Host(Box<Request<'static>>),
    Extension(Box<Response<ResultValue>>),
    Progress(ProgressNotification),
    Cancel(CancelNotification),
}

pub fn schema() -> Schema {
    schemars::generate::SchemaSettings::draft2020_12()
        .for_deserialize()
        .with_transform(RecursiveTransform(|schema: &mut Schema| {
            // Formats are advisory. These constraints match the wire decoder.
            let (minimum, maximum) = match schema.get("format").and_then(Value::as_str) {
                Some("int32") => (i32::MIN.into(), i32::MAX.into()),
                Some("uint32") => (0.into(), u32::MAX.into()),
                Some("uint64") => (0.into(), u64::MAX.into()),
                _ => return,
            };
            schema.insert("minimum".to_owned(), minimum);
            schema.insert("maximum".to_owned(), maximum);
        }))
        .into_generator()
        .into_root_schema_for::<Contract2>()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use serde_json::json;

    #[test]
    fn schema_and_decoder_agree_on_describe_pid_limit() {
        let schema = serde_json::to_value(schema()).unwrap();
        let describe = &schema["$defs"]["Request"]["oneOf"][0]["properties"];
        assert_eq!(describe["method"]["const"], "describe");
        let pid = &describe["params"]["properties"]["pid"];
        assert_eq!(pid["minimum"], 0);
        assert_eq!(pid["maximum"], u32::MAX);

        let mut request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "describe",
            "params": {"contract_versions": [2], "pid": u32::MAX}
        });
        assert!(serde_json::from_value::<Request<'_>>(request.clone()).is_ok());
        request["params"]["pid"] = json!(u64::from(u32::MAX) + 1);
        assert!(serde_json::from_value::<Request<'_>>(request).is_err());
    }

    #[test]
    fn the_future_event_schema_does_not_accept_malformed_known_events() {
        use crate::ExternalEventKind;

        let schema = serde_json::to_value(schema()).unwrap();
        let choices = schema["$defs"]["ExternalEventKind"]["oneOf"]
            .as_array()
            .unwrap();
        let unknown = choices.last().unwrap();
        assert_eq!(unknown["required"], json!(["event"]));
        let excluded = unknown["properties"]["event"]["not"]["enum"]
            .as_array()
            .unwrap();
        for known in &choices[..choices.len() - 1] {
            assert!(excluded.contains(&known["properties"]["event"]["const"]));
        }
        assert!(!excluded.contains(&json!("review_requested")));
        assert!(serde_json::from_value::<ExternalEventKind>(json!({"event": "closed"})).is_err());
        let assigned = choices
            .iter()
            .find(|choice| choice["properties"]["event"]["const"] == "assigned")
            .unwrap();
        assert_eq!(assigned["properties"]["category"]["type"], "null");
        assert!(
            serde_json::from_value::<ExternalEventKind>(
                json!({"event": "assigned", "category": "completed"})
            )
            .is_err()
        );
        assert_eq!(
            serde_json::from_value::<ExternalEventKind>(
                json!({"event": "assigned", "category": null})
            )
            .unwrap(),
            ExternalEventKind::Assigned
        );
        assert_eq!(
            serde_json::from_value::<ExternalEventKind>(json!({"event": "review_requested"}))
                .unwrap(),
            ExternalEventKind::Unsupported
        );
    }
}
