//! Uncaught errors from the WebView, which the page sends through one Tauri command.
//!
//! The page already drops repeats and limits itself to ten a minute; this side bounds what
//! it accepts, since the page is outside the Rust code, and records one event. The error's
//! message is never sent or logged: it can quote a Ticket, a Document or a Harness.

use serde::Deserialize;

const MAX_FRAMES: usize = 10;
const MAX_FRAME_FILE: usize = 100;
const MAX_ROUTE: usize = 64;
const MAX_NAME: usize = 64;

/// An uncaught error as the page reports it.
#[derive(Debug, Clone, Deserialize)]
pub struct WebviewError {
    /// The error's constructor name, such as `TypeError`.
    pub name: String,
    /// Stack frames reduced by the page to `file:line:column`, such as `index.js:10:5`.
    pub frames: Vec<String>,
    /// The view the person was on.
    pub route: String,
    /// How many times it happened since it was last reported.
    pub count: u32,
}

/// Records the error as an `error` event on the `ticketd::webview` target (it starts with
/// `ticketd` so the default filter treats it like our own crates). The kind is the error's
/// name, kept only when it is a plain identifier so that text a page invents cannot become
/// a grouping key. Only frames shaped `file:line:column` are kept, so no URL, query string
/// or function name reaches the log.
pub fn record_webview_error(error: &WebviewError) {
    let kind = if is_identifier(&error.name) {
        error.name.as_str()
    } else {
        "Error"
    };
    let frames = error
        .frames
        .iter()
        .filter(|frame| is_frame(frame))
        .take(MAX_FRAMES)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    tracing::error!(
        target: "ticketd::webview",
        error_kind = kind,
        route = %bounded(&error.route, MAX_ROUTE),
        repeat_count = error.count.max(1),
        frames = %frames,
        "uncaught WebView error"
    );
}

fn is_identifier(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// `file:line:column`, where the file is a base name and the position is numeric.
fn is_frame(frame: &str) -> bool {
    let mut parts = frame.rsplitn(3, ':');
    let (Some(column), Some(line), Some(file)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let number = |text: &str| {
        !text.is_empty() && text.len() <= 9 && text.bytes().all(|b| b.is_ascii_digit())
    };
    !file.is_empty()
        && file.len() <= MAX_FRAME_FILE
        && file
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '$'))
        && number(line)
        && number(column)
}

fn bounded(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}
