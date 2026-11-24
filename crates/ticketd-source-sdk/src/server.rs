//! Runs the provider on a worker so the reader can receive cancellation during I/O.
use std::{
    io::{self, BufRead, Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    CONTRACT_VERSION, ChoiceOption, ConfigValues, ConnectionCheck, Conversation, DiscoveryPage,
    DiscoveryRequest, ErrorClass, ErrorCode, ExternalIssue, ExternalRef, FieldIssue,
    PublicationCandidates, PublicationSearch, PublishRequest, SourceDescription,
    wire::{
        Call, CancelNotification, Description, Failure, JsonRpc, LINE_LIMIT, ProgressMethod,
        ProgressNotification, ProgressParams, REQUEST_CANCELED, Request, ResultValue, RpcError,
        Success, WireFailure, valid_failure_detail,
    },
};

type Operation<T> = Result<T, ExtensionError>;

/// The tracker operations ticketd can request. Implement the optional methods
/// when declaring their corresponding capabilities in the description.
pub trait Extension: Send + Sync + 'static {
    fn description(&self) -> SourceDescription;
    fn check_connection(
        &self,
        context: &RequestContext<'_>,
        config: &ConfigValues,
    ) -> Operation<ConnectionCheck>;

    fn validate(
        &self,
        _context: &RequestContext<'_>,
        _config: &ConfigValues,
    ) -> Operation<Vec<FieldIssue>> {
        Ok(Vec::new())
    }

    fn options(
        &self,
        _context: &RequestContext<'_>,
        _config: &ConfigValues,
        _field: &str,
        _query: &str,
    ) -> Operation<Vec<ChoiceOption>> {
        Err(ExtensionError::unsupported("setting options"))
    }

    fn discover(
        &self,
        context: &RequestContext<'_>,
        request: DiscoveryRequest<'_>,
    ) -> Operation<DiscoveryPage>;

    fn fetch(
        &self,
        context: &RequestContext<'_>,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Operation<ExternalIssue>;

    fn conversation(
        &self,
        _context: &RequestContext<'_>,
        _config: &ConfigValues,
        _reference: &ExternalRef,
    ) -> Operation<Conversation> {
        Err(ExtensionError::unsupported("conversation"))
    }

    fn publish(
        &self,
        _context: &RequestContext<'_>,
        _config: &ConfigValues,
        _request: &PublishRequest,
    ) -> Operation<ExternalIssue> {
        Err(ExtensionError::unsupported("publication"))
    }

    fn locate(
        &self,
        _context: &RequestContext<'_>,
        _config: &ConfigValues,
        _destination: &str,
        _text: &str,
    ) -> Operation<ExternalIssue> {
        Err(ExtensionError::unsupported("issue lookup"))
    }

    fn find_published(
        &self,
        _context: &RequestContext<'_>,
        _config: &ConfigValues,
        _search: &PublicationSearch,
    ) -> Operation<PublicationCandidates> {
        Err(ExtensionError::unsupported("publication recovery"))
    }
}

/// A classified failure, with a person-readable message that contains no
/// credentials or raw tracker responses.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ExtensionError {
    code: ErrorCode,
    message: String,
    detail: Option<&'static str>,
    fields: Vec<FieldIssue>,
    retry_after_secs: Option<u64>,
}

impl ExtensionError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
            fields: Vec::new(),
            retry_after_secs: None,
        }
    }

    pub fn configuration(fields: Vec<FieldIssue>) -> Self {
        Self {
            fields,
            ..Self::new(ErrorCode::InvalidConfiguration, "check the source settings")
        }
    }

    pub fn rate_limited(retry_after_secs: Option<u64>) -> Self {
        Self {
            retry_after_secs,
            ..Self::new(
                ErrorCode::RateLimited,
                "the source is rate limiting requests",
            )
        }
    }

    pub fn unsupported(operation: &str) -> Self {
        Self::new(
            ErrorCode::Unsupported,
            format!("this source does not support {operation}"),
        )
    }

    /// Attach a fixed diagnostic code to the wire response. ticketd does not log it.
    /// Never use tracker error text, credentials or issue content here.
    pub fn with_detail(mut self, detail: &'static str) -> Self {
        self.detail = valid_failure_detail(detail).then_some(detail);
        self
    }

    pub fn code(&self) -> ErrorCode {
        self.code
    }

    fn into_rpc(self) -> RpcError {
        use ErrorCode::*;
        let class = match self.code {
            Unauthenticated | Forbidden => ErrorClass::Auth,
            NotFound | Rejected | InvalidConfiguration => ErrorClass::Config,
            RateLimited | Unavailable | NotSent => ErrorClass::Transient,
            Protocol | Unsupported => ErrorClass::System,
        };
        RpcError {
            code: -32000,
            message: "source operation failed".into(),
            data: Some(WireFailure {
                class,
                code: self.code,
                message: self.message,
                detail: self.detail.map(str::to_owned),
                fields: self.fields,
                retry_after_secs: self.retry_after_secs,
            }),
        }
    }
}

/// The current request's cancellation state and progress channel. Providers
/// should check cancellation before sending a request and between pages.
pub struct RequestContext<'a> {
    connection_id: &'a str,
    canceled: &'a AtomicBool,
    send_progress: &'a dyn Fn(u32, Option<u32>) -> io::Result<()>,
}

impl RequestContext<'_> {
    pub fn connection_id(&self) -> &str {
        self.connection_id
    }

    pub fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::Acquire)
    }

    /// Report work completed inside this request. Use counts the user can
    /// interpret, with no total when the tracker does not know it.
    pub fn progress(&self, completed: u32, total: Option<u32>) -> Operation<()> {
        if self.is_canceled() {
            return Err(ExtensionError::new(
                ErrorCode::Unavailable,
                "the source request was canceled",
            ));
        }
        if total.is_some_and(|total| completed > total) {
            return Err(ExtensionError::new(
                ErrorCode::Protocol,
                "progress exceeds the request total",
            ));
        }
        (self.send_progress)(completed, total).map_err(|_| {
            ExtensionError::new(ErrorCode::Unavailable, "could not send source progress")
        })
    }
}

/// Serve requests over standard input and output. Leave stdout dedicated to
/// these messages for the entire life of the extension process.
pub fn serve_stdio(version: &str, extension: impl Extension) -> io::Result<()> {
    serve(io::stdin().lock(), io::stdout(), version, extension)
}

/// Serve the same protocol over supplied streams, for author-side conformance
/// fixtures. Closing the reader cancels active work and ends the session.
pub fn serve(
    mut reader: impl BufRead,
    writer: impl Write + Send + 'static,
    version: &str,
    extension: impl Extension,
) -> io::Result<()> {
    let extension = Arc::new(extension);
    let session = Arc::new(Session {
        writer: Mutex::new(writer),
        active: Mutex::new(None),
    });
    let mut negotiated = false;
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader
            .by_ref()
            .take((LINE_LIMIT + 1) as u64)
            .read_until(b'\n', &mut line)?
            == 0
        {
            session.cancel(None);
            return Ok(());
        }
        if line.len() > LINE_LIMIT + 1 || line.last() != Some(&b'\n') {
            session.cancel(None);
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid source request frame",
            ));
        }
        let inbound: Inbound = serde_json::from_slice(&line)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid source request"))?;
        match inbound {
            Inbound::Cancel(notice) => session.cancel(Some(notice.params.id)),
            Inbound::Other(message) => {
                if matches!(
                    message.method.as_str(),
                    "describe"
                        | "check_connection"
                        | "validate"
                        | "options"
                        | "discover"
                        | "fetch"
                        | "conversation"
                        | "publish"
                        | "locate"
                        | "find_published"
                        | "cancel"
                ) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "invalid source request",
                    ));
                }
                if let Some(id) = message.id {
                    session.failure(
                        id,
                        RpcError {
                            code: -32601,
                            message: "method not found".into(),
                            data: None,
                        },
                    )?;
                }
            }
            Inbound::Request(request) => {
                let Request { id, call, .. } = request;
                if let Call::Describe {
                    contract_versions, ..
                } = call
                {
                    negotiated = contract_versions.contains(&CONTRACT_VERSION);
                    session.write(&Success {
                        jsonrpc: JsonRpc::V2,
                        id,
                        result: ResultValue::Describe(Description {
                            contract_versions: vec![CONTRACT_VERSION],
                            contract_version: negotiated.then_some(CONTRACT_VERSION),
                            version: version.to_owned(),
                            description: negotiated.then(|| extension.description()),
                        }),
                    })?;
                } else if negotiated {
                    session.start(id, call, Arc::clone(&extension))?;
                } else {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the source host must first negotiate a contract",
                    ));
                }
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Inbound {
    Request(Request<'static>),
    Cancel(CancelNotification),
    Other(OtherMethod),
}

#[derive(Deserialize)]
struct OtherMethod {
    #[serde(rename = "jsonrpc")]
    _jsonrpc: JsonRpc,
    method: String,
    #[serde(default, deserialize_with = "request_id")]
    id: Option<u64>,
}

fn request_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    // Only an absent id denotes a notification. Requests carry numeric ids.
    u64::deserialize(deserializer).map(Some)
}

struct Active {
    id: u64,
    canceled: Arc<AtomicBool>,
}

struct Session<W> {
    writer: Mutex<W>,
    active: Mutex<Option<Active>>,
}

impl<W: Write + Send + 'static> Session<W> {
    fn start(
        self: &Arc<Self>,
        id: u64,
        call: Call<'static>,
        extension: Arc<impl Extension>,
    ) -> io::Result<()> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| io::Error::other("the source session lock was poisoned"))?;
        if active.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "source requests must be serial",
            ));
        }
        let canceled = Arc::new(AtomicBool::new(false));
        *active = Some(Active {
            id,
            canceled: Arc::clone(&canceled),
        });
        let session = Arc::clone(self);
        thread::Builder::new().spawn(move || {
            let send_progress = |completed, total| {
                session.write(&ProgressNotification {
                    jsonrpc: JsonRpc::V2,
                    method: ProgressMethod::Progress,
                    params: ProgressParams {
                        id,
                        completed,
                        total,
                    },
                })
            };
            let result = dispatch(&*extension, call, &canceled, &send_progress);
            // Hold the slot until the terminal response is written. The next
            // request can arrive immediately after the host reads the response.
            if let Ok(mut active) = session.active.lock() {
                let response = if canceled.load(Ordering::Acquire) {
                    session.failure(
                        id,
                        RpcError {
                            code: REQUEST_CANCELED,
                            message: "request canceled".into(),
                            data: None,
                        },
                    )
                } else {
                    match result {
                        Ok(result) => session.write(&Success {
                            jsonrpc: JsonRpc::V2,
                            id,
                            result,
                        }),
                        Err(error) => session.failure(id, error.into_rpc()),
                    }
                };
                if response
                    .as_ref()
                    .is_err_and(|error| error.kind() == io::ErrorKind::InvalidData)
                {
                    let _ = session.failure(
                        id,
                        ExtensionError::new(
                            ErrorCode::Protocol,
                            "the source result exceeds the protocol line limit",
                        )
                        .into_rpc(),
                    );
                }
                *active = None;
            }
        })?;
        Ok(())
    }

    fn cancel(&self, id: Option<u64>) {
        let active = if id.is_none() {
            // EOF must end the process even when the host stopped draining stdout.
            self.active.try_lock().ok()
        } else {
            self.active.lock().ok()
        };
        if let Some(active) = active
            && let Some(active) = &*active
            && id.is_none_or(|id| id == active.id)
        {
            active.canceled.store(true, Ordering::Release);
        }
    }

    fn write(&self, value: &impl Serialize) -> io::Result<()> {
        let line = serde_json::to_vec(value)
            .map_err(|_| io::Error::other("could not encode a source response"))?;
        if line.len() > LINE_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "source response exceeds the protocol line limit",
            ));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("the source session lock was poisoned"))?;
        writer.write_all(&line)?;
        writer.write_all(b"\n")?;
        writer.flush()
    }

    fn failure(&self, id: u64, error: RpcError) -> io::Result<()> {
        self.write(&Failure {
            jsonrpc: JsonRpc::V2,
            id,
            error,
        })
    }
}

fn dispatch(
    extension: &impl Extension,
    call: Call<'_>,
    canceled: &AtomicBool,
    send_progress: &dyn Fn(u32, Option<u32>) -> io::Result<()>,
) -> Operation<ResultValue> {
    let context = |connection_id| RequestContext {
        connection_id,
        canceled,
        send_progress,
    };
    match &call {
        Call::Describe { .. } => Err(ExtensionError::new(
            ErrorCode::Protocol,
            "unexpected describe call",
        )),
        Call::CheckConnection(params) => extension
            .check_connection(&context(&params.connection_id), &params.config)
            .map(ResultValue::CheckConnection),
        Call::Validate(params) => extension
            .validate(&context(&params.connection_id), &params.config)
            .map(ResultValue::Validate),
        Call::Options {
            connection,
            field,
            query,
        } => extension
            .options(
                &context(&connection.connection_id),
                &connection.config,
                field,
                query,
            )
            .map(ResultValue::Options),
        Call::Discover {
            connection,
            cursor,
            page_size,
        } => extension
            .discover(
                &context(&connection.connection_id),
                DiscoveryRequest {
                    config: &connection.config,
                    cursor: cursor.as_deref(),
                    page_size: *page_size,
                },
            )
            .map(ResultValue::Discover),
        Call::Fetch(params) => extension
            .fetch(
                &context(&params.connection.connection_id),
                &params.connection.config,
                &params.reference,
            )
            .map(ResultValue::Issue),
        Call::Conversation(params) => extension
            .conversation(
                &context(&params.connection.connection_id),
                &params.connection.config,
                &params.reference,
            )
            .map(ResultValue::Conversation),
        Call::Publish {
            connection,
            request,
        } => extension
            .publish(
                &context(&connection.connection_id),
                &connection.config,
                request,
            )
            .map(ResultValue::Issue),
        Call::Locate {
            connection,
            destination,
            text,
        } => extension
            .locate(
                &context(&connection.connection_id),
                &connection.config,
                destination,
                text,
            )
            .map(ResultValue::Issue),
        Call::FindPublished { connection, search } => extension
            .find_published(
                &context(&connection.connection_id),
                &connection.config,
                search,
            )
            .map(ResultValue::FindPublished),
    }
}
