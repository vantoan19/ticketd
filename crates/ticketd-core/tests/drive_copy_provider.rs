use std::sync::Mutex;
use ticketd_core::drive::*;

struct Vault;
impl CredentialStore for Vault {
    fn load(&self, _: &str) -> Result<DriveCredential, DriveError> {
        Ok(DriveCredential {
            client_id: "client".into(),
            client_secret: None,
            refresh_token: "secret-refresh".into(),
        })
    }
    fn save(&self, _: &str, _: &DriveCredential) -> Result<(), DriveError> {
        Ok(())
    }
}
struct Http {
    responses: Mutex<Vec<DriveResponse>>,
    requests: Mutex<Vec<DriveRequest>>,
}
#[allow(clippy::unwrap_used)]
impl DriveTransport for Http {
    fn send(&self, r: DriveRequest) -> Result<DriveResponse, DriveError> {
        // The real transport refuses anything outside its allow-list.
        assert!(
            ticketd_core::drive::request_allowed(r.method, &r.url),
            "GoogleTransport refuses {} {}",
            r.method,
            r.url
        );
        let is_token = r.url == TOKEN_URL;
        self.requests.lock().unwrap().push(r);
        if is_token {
            return Ok(token());
        }
        Ok(self.responses.lock().unwrap().remove(0))
    }
}
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
fn response(status: u16, body: &[u8]) -> DriveResponse {
    DriveResponse {
        status,
        body: body.into(),
        headers: vec![],
    }
}
fn token() -> DriveResponse {
    response(200, br#"{"access_token":"secret-access"}"#)
}
fn reference() -> DriveReference {
    DriveReference {
        connection_id: "copy-fixture".into(),
        metadata: DriveMetadata {
            id: "blob".into(),
            name: "trace.log".into(),
            mime_type: "application/octet-stream".into(),
            size_bytes: Some(14),
            web_url: "https://drive.google.com/file/d/blob/view".into(),
            resource_key: Some("key".into()),
        },
    }
}

#[test]
fn google_copy_download_uses_authorized_bounded_blob_reads_without_mutation_or_conversion() {
    let http=Http { requests:Mutex::new(vec![]),responses:Mutex::new(vec![response(200,br#"{"id":"blob","name":"trace.log","mimeType":"application/octet-stream","size":"14","sha256Checksum":"52c3935626c104b2cbc9031291a1c4d56614c38f52072a361d658a58a9c48698","version":"1","capabilities":{"canDownload":true}}"#),DriveResponse {status:206,body:b"original bytes".to_vec(),headers:vec![("Content-Range".into(),"bytes 0-13/14".into())]}]) };
    let provider = GoogleDriveCopies::new(&Vault, &http);
    let metadata = provider.inspect(&reference()).unwrap();
    assert_eq!(metadata.version.as_deref(), Some("1"));
    assert_eq!(metadata.can_download, Some(true));
    let mut output = Vec::new();
    provider.download(&reference(), 14, &mut output).unwrap();
    assert_eq!(output, b"original bytes");
    let all = http.requests.lock().unwrap();
    assert_eq!(
        all.iter().filter(|r| r.url == TOKEN_URL).count(),
        1,
        "inspecting and downloading share one access token"
    );
    let requests: Vec<_> = all.iter().filter(|r| r.url != TOKEN_URL).collect();
    assert_eq!(
        requests[1]
            .headers
            .iter()
            .find(|(k, _)| k == "Range")
            .unwrap()
            .1,
        "bytes=0-13"
    );
    assert!(
        requests[1]
            .headers
            .contains(&("X-Goog-Drive-Resource-Keys".into(), "blob/key".into()))
    );
    assert!(requests[1].url.contains("alt=media"));
    assert!(requests.iter().all(|r| r.method == "GET"));
    assert!(!format!("{all:?}").contains("secret"));
}

#[test]
fn native_content_is_not_converted_or_downloaded_even_when_provider_called_directly() {
    let http = Http {
        requests: Mutex::new(vec![]),
        responses: Mutex::new(vec![response(200, b"original bytes")]),
    };
    let provider = GoogleDriveCopies::new(&Vault, &http);
    let mut reference = reference();
    reference.metadata.mime_type = "application/vnd.google-apps.document".into();
    let error = provider
        .download(&reference, 14, &mut Vec::new())
        .unwrap_err();
    assert_eq!(error.kind, DriveErrorKind::Unsupported);
    assert!(http.requests.lock().unwrap().is_empty());
}

#[test]
fn ranged_download_handles_multiple_chunks_and_refuses_inconsistent_or_short_responses() {
    let http = Http {
        requests: Mutex::new(vec![]),
        responses: Mutex::new(vec![
            DriveResponse {
                status: 206,
                body: vec![b'a'; 262144],
                headers: vec![("content-range".into(), "bytes 0-262143/262147".into())],
            },
            DriveResponse {
                status: 206,
                body: b"end".to_vec(),
                headers: vec![("Content-Range".into(), "bytes 262144-262146/262147".into())],
            },
        ]),
    };
    let provider = GoogleDriveCopies::new(&Vault, &http);
    let mut output = Vec::new();
    provider
        .download(&reference(), 262147, &mut output)
        .unwrap();
    assert_eq!(output.len(), 262147);
    assert_eq!(&output[262144..], b"end");
    let requests = http.requests.lock().unwrap();
    let reads: Vec<_> = requests.iter().filter(|r| r.url != TOKEN_URL).collect();
    assert_eq!(reads.len(), 2);
    assert_eq!(
        reads[1]
            .headers
            .iter()
            .find(|(k, _)| k == "Range")
            .unwrap()
            .1,
        "bytes=262144-262146"
    );
    drop(requests);
    for (range, bytes) in [
        ("bytes 0-13/15", &b"original bytes"[..]),
        ("bytes 0-13/14", &b"short"[..]),
    ] {
        let http = Http {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![DriveResponse {
                status: 206,
                body: bytes.into(),
                headers: vec![("Content-Range".into(), range.into())],
            }]),
        };
        let mut output = Vec::new();
        assert!(
            GoogleDriveCopies::new(&Vault, &http)
                .download(&reference(), 14, &mut output)
                .is_err()
        );
        assert!(output.is_empty());
    }
}
