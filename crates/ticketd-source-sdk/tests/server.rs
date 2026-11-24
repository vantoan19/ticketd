#![allow(clippy::unwrap_used)]

use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use serde_json::{Value, json};
use ticketd_source_sdk::{
    Capability, ConfigSchema, ConfigValues, ConnectionCheck, ConnectorDescriptor, DiscoveryPage,
    DiscoveryRequest, Extension, ExtensionError, ExternalIssue, ExternalRef, RequestContext,
    SourceDescription, SourcePresentation, serve,
};

struct Tracker(Arc<Mutex<Vec<String>>>);

impl Extension for Tracker {
    fn description(&self) -> SourceDescription {
        SourceDescription {
            descriptor: ConnectorDescriptor {
                provider: "fixture".into(),
                name: "Fixture".into(),
                contract_version: 2,
                capabilities: vec![Capability::Discover, Capability::Fetch, Capability::Publish],
                schema: ConfigSchema { fields: vec![] },
            },
            presentation: SourcePresentation::default(),
        }
    }

    fn check_connection(
        &self,
        _context: &RequestContext<'_>,
        _config: &ConfigValues,
    ) -> Result<ConnectionCheck, ExtensionError> {
        Ok(ConnectionCheck {
            connection: ticketd_source_sdk::ConnectionInfo {
                account: "Fixture User".into(),
                account_id: Some("fixture-user".into()),
                site: "fixture-site".into(),
                tracker_time: None,
                publication_requires_tracker_time: false,
            },
            derived: Default::default(),
        })
    }

    fn discover(
        &self,
        context: &RequestContext<'_>,
        _request: DiscoveryRequest<'_>,
    ) -> Result<DiscoveryPage, ExtensionError> {
        self.0.lock().unwrap().push(context.connection_id().into());
        context.progress(1, Some(2))?;
        while !context.is_canceled() {
            thread::yield_now();
        }
        Ok(DiscoveryPage {
            issues: vec![],
            next_cursor: None,
            skipped: vec![],
        })
    }

    fn fetch(
        &self,
        _context: &RequestContext<'_>,
        _config: &ConfigValues,
        _reference: &ExternalRef,
    ) -> Result<ExternalIssue, ExtensionError> {
        Err(ExtensionError::unsupported("fetch").with_detail("fixture_fetch_missing"))
    }
}

#[test]
fn sdk_negotiates_reports_progress_cancels_and_handles_the_next_call() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let host = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let (extension, _) = listener.accept().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let tracker = Tracker(seen.clone());
    let extension_reader = extension.try_clone().unwrap();
    let session = thread::spawn(|| {
        serve(
            BufReader::new(extension_reader),
            extension,
            "1.0.0",
            tracker,
        )
    });
    let mut input = host.try_clone().unwrap();
    let mut output = BufReader::new(host);
    let send = |input: &mut TcpStream, method, id, params: Value| {
        let mut value = json!({"jsonrpc":"2.0","method":method,"params":params});
        if let Some(id) = id {
            value["id"] = json!(id);
        }
        writeln!(input, "{value}").unwrap();
    };
    let receive = |output: &mut BufReader<TcpStream>| {
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(&line).unwrap()
    };
    send(
        &mut input,
        "describe",
        Some(1),
        json!({"contract_versions":[2],"pid":42}),
    );
    let hello = receive(&mut output);
    assert_eq!(hello["result"]["contract_version"], 2);
    assert_eq!(
        hello["result"]["description"]["capabilities"],
        json!(["discover", "fetch"]),
    );
    send(
        &mut input,
        "discover",
        Some(2),
        json!({"connection_id":"fixture-2","config":{},"cursor":null,"page_size":1}),
    );
    assert_eq!(
        receive(&mut output),
        json!({"jsonrpc":"2.0","method":"progress","params":{"id":2,"completed":1,"total":2}})
    );
    send(&mut input, "future_notification", None, json!({"id":2}));
    send(&mut input, "future_request", Some(5), json!({"id":2}));
    let unknown = receive(&mut output);
    assert_eq!(unknown["id"], 5);
    assert_eq!(unknown["error"]["code"], -32601);
    send(&mut input, "cancel", None, json!({"id":2}));
    assert_eq!(receive(&mut output)["error"]["code"], -32800);
    send(
        &mut input,
        "check_connection",
        Some(3),
        json!({"connection_id":"fixture-2","config":{}}),
    );
    assert_eq!(
        receive(&mut output)["result"]["connection"]["account_id"],
        "fixture-user"
    );
    send(
        &mut input,
        "fetch",
        Some(4),
        json!({"connection_id":"fixture-2","config":{},"reference":{
            "identity":{"provider":"fixture","id":"issue-1"},"locator":"F-1","partition":"F"
        }}),
    );
    let failure = receive(&mut output);
    assert_eq!(failure["error"]["data"]["detail"], "fixture_fetch_missing");
    assert_eq!(
        failure["error"]["data"]["message"],
        "this source does not support fetch"
    );
    send(
        &mut input,
        "discover",
        Some(6),
        json!({"connection_id":"fixture-2","config":{},"cursor":null,"page_size":1}),
    );
    assert_eq!(receive(&mut output)["params"]["id"], 6);
    // Malformed known requests must fail without stranding active extension work.
    send(&mut input, "publish", Some(7), json!({}));
    let failure = session.join().unwrap().unwrap_err();
    assert_eq!(failure.kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(
        receive(&mut output),
        json!({
            "jsonrpc": "2.0",
            "id": 6,
            "error": {"code": -32800, "message": "request canceled", "data": null}
        })
    );
    assert_eq!(*seen.lock().unwrap(), ["fixture-2", "fixture-2"]);
}
