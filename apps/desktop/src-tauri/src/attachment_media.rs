use tauri::http::{Method, Request, Response, StatusCode};
use ticketd_core::Workspace;

const RANGE_BYTES: u64 = 1024 * 1024;

fn response(
    status: StatusCode,
    mime: &'static str,
    length: u64,
    range: Option<String>,
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Content-Length", length)
        .header("Accept-Ranges", "bytes")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Content-Security-Policy", "default-src 'none'; sandbox");
    if let Some(range) = range {
        builder = builder.header("Content-Range", range);
    }
    if status == StatusCode::METHOD_NOT_ALLOWED {
        builder = builder.header("Allow", "GET, HEAD");
    }
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub(crate) fn denied(status: StatusCode) -> Response<Vec<u8>> {
    response(status, "text/plain", 0, None, Vec::new())
}

/// Protocol translation only. Workspace owns identity, byte authorization and media policy.
fn respond(workspace: &Workspace, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return denied(StatusCode::METHOD_NOT_ALLOWED);
    }
    let uri = request.uri();
    if !matches!(
        (uri.scheme_str(), uri.host()),
        (Some("attachment-media"), Some("localhost"))
            | (Some("http" | "https"), Some("attachment-media.localhost"))
    ) || uri.query().is_some()
    {
        return denied(StatusCode::NOT_FOUND);
    }
    let path: Vec<_> = uri
        .path()
        .strip_prefix('/')
        .unwrap_or("")
        .split('/')
        .collect();
    if path.len() != 2 {
        return denied(StatusCode::NOT_FOUND);
    }
    let Ok(mut media) = workspace.attachment_media(path[0], path[1]) else {
        return denied(StatusCode::NOT_FOUND);
    };
    let total = media.len();
    if request.method() == Method::HEAD {
        return response(StatusCode::OK, media.media_type(), total, None, Vec::new());
    }
    let range = request
        .headers()
        .get("Range")
        .and_then(|value| value.to_str().ok());
    let selection = match byte_range(range, total) {
        Ok(range) => range,
        Err(()) => {
            return response(
                StatusCode::RANGE_NOT_SATISFIABLE,
                media.media_type(),
                0,
                Some(format!("bytes */{total}")),
                Vec::new(),
            );
        }
    };
    let (status, start, length, content_range) = match selection {
        Some((start, end)) => (
            StatusCode::PARTIAL_CONTENT,
            start,
            end - start + 1,
            Some(format!("bytes {start}-{end}/{total}")),
        ),
        None => (StatusCode::OK, 0, total, None),
    };
    match media.read(start, length) {
        Ok(bytes) => response(status, media.media_type(), length, content_range, bytes),
        Err(_) => denied(StatusCode::NOT_FOUND),
    }
}

fn byte_range(header: Option<&str>, total: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(range) = header.and_then(|h| h.strip_prefix("bytes=")) else {
        return Ok(None);
    };
    // Multiple ranges may be ignored; a full 200 must remain a complete representation.
    if range.contains(',') {
        return Ok(None);
    }
    let (start, end) = range.split_once('-').ok_or(())?;
    let number = |value: &str| {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(());
        }
        value.parse::<u64>().map_err(|_| ())
    };
    if total == 0 {
        return Err(());
    }
    let (start, end) = if start.is_empty() {
        let suffix = number(end)?;
        if suffix == 0 {
            return Err(());
        }
        (total.saturating_sub(suffix), total - 1)
    } else {
        let start = number(start)?;
        let end = if end.is_empty() {
            total - 1
        } else {
            number(end)?.min(total - 1)
        };
        if start >= total || end < start {
            return Err(());
        }
        (start, end)
    };
    Ok(Some((
        start,
        end.min(start.saturating_add(RANGE_BYTES - 1)),
    )))
}

pub(crate) fn handle(request: Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    struct Permit;
    impl Drop for Permit {
        fn drop(&mut self) {
            ACTIVE.fetch_sub(1, Ordering::Release);
        }
    }
    if ACTIVE
        .try_update(Ordering::AcqRel, Ordering::Acquire, |active| {
            (active < 2).then_some(active + 1)
        })
        .is_err()
    {
        responder.respond(denied(StatusCode::SERVICE_UNAVAILABLE));
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = Permit;
        let response = match super::open_workspace() {
            Ok(workspace) => respond(&workspace, &request),
            Err(_) => denied(StatusCode::NOT_FOUND),
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::respond;

    #[test]
    fn large_ranges_are_bounded_without_truncating_full_responses_or_serving_active_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
        let mut bytes = b"RIFF\x24\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0".to_vec();
        bytes.resize(3 * 1024 * 1024, 42);
        let file = workspace
            .import_attachment_bytes("large", "recording.wav", &bytes, |_, _| true)
            .unwrap();
        let prefix = format!(
            "http://attachment-media.localhost/{}",
            workspace.attachment_workspace_id().unwrap()
        );
        let request = |id: &str, range: Option<&str>| {
            let mut request = Request::builder().uri(format!("{prefix}/{id}"));
            if let Some(range) = range {
                request = request.header("Range", range);
            }
            request.body(Vec::new()).unwrap()
        };
        let response = respond(&workspace, &request(&file.id, Some("bytes=1048576-")));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers()["Content-Range"],
            "bytes 1048576-2097151/3145728"
        );
        assert_eq!(response.body(), &bytes[1048576..2097152]);
        let full = respond(&workspace, &request(&file.id, None));
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body(), &bytes);
        for (id, content) in [
            ("html", b"<html><script>throw 1</script></html>".as_slice()),
            ("empty", b"".as_slice()),
        ] {
            let file = workspace
                .import_attachment_bytes(id, "fake.png", content, |_, _| true)
                .unwrap();
            let response = respond(&workspace, &request(&file.id, None));
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert!(response.body().is_empty());
        }
    }
    use tauri::http::{Request, StatusCode};
    use ticketd_core::Workspace;

    #[test]
    fn media_responses_support_head_and_exact_ranges_with_defensive_headers() {
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
        let bytes = b"RIFF\x24\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0";
        let file = workspace
            .import_attachment_bytes("audio", "sound.wav", bytes, |_, _| true)
            .unwrap();
        let uri = format!(
            "attachment-media://localhost/{}/{}",
            workspace.attachment_workspace_id().unwrap(),
            file.id
        );
        let request = |method, range: Option<&str>| {
            let mut request = Request::builder().uri(&uri).method(method);
            if let Some(range) = range {
                request = request.header("Range", range);
            }
            request.body(Vec::new()).unwrap()
        };
        let full = respond(&workspace, &request("GET", None));
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body(), bytes);
        assert_eq!(full.headers()["Content-Type"], "audio/wav");
        assert_eq!(full.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(full.headers()["Cache-Control"], "no-store");
        assert!(!full.headers().contains_key("Access-Control-Allow-Origin"));
        for (range, content_range, expected) in [
            ("bytes=2-5", "bytes 2-5/24", &bytes[2..6]),
            ("bytes=20-", "bytes 20-23/24", &bytes[20..]),
            ("bytes=-3", "bytes 21-23/24", &bytes[21..]),
        ] {
            let response = respond(&workspace, &request("GET", Some(range)));
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.headers()["Content-Range"], content_range);
            assert_eq!(response.body(), expected);
            assert_eq!(
                response.headers()["Content-Length"],
                expected.len().to_string()
            );
        }
        let head = respond(&workspace, &request("HEAD", Some("bytes=2-5")));
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()["Content-Length"], "24");
        assert!(head.body().is_empty());
        for range in [
            "bytes=24-",
            "bytes=5-2",
            "bytes=-0",
            "bytes=18446744073709551616-",
        ] {
            let response = respond(&workspace, &request("GET", Some(range)));
            assert_eq!(
                response.status(),
                StatusCode::RANGE_NOT_SATISFIABLE,
                "{range}"
            );
            assert_eq!(response.headers()["Content-Range"], "bytes */24");
        }
        for range in ["bytes=0-1,4-5", "items=0-1"] {
            assert_eq!(
                respond(&workspace, &request("GET", Some(range))).status(),
                StatusCode::OK
            );
        }
        assert_eq!(
            respond(&workspace, &request("POST", None)).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        for path in [
            "/foreign/id",
            "/../secret",
            "/%2e%2e/secret",
            "/C:/secret",
            "/workspace/id?path=secret",
        ] {
            let request = Request::builder()
                .uri(format!("attachment-media://localhost{path}"))
                .body(Vec::new())
                .unwrap();
            assert_eq!(
                respond(&workspace, &request).status(),
                StatusCode::NOT_FOUND
            );
        }
    }
}
