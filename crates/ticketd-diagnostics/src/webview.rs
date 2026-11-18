//! Uncaught errors from the WebView, which the page sends through one Tauri command.
//!
//! The page already drops repeats and limits itself to ten a minute; this side bounds what
//! it accepts, since the page is outside the Rust code, and records one event.

use serde::Deserialize;

const MAX_MESSAGE: usize = 500;
const MAX_FRAMES: usize = 10;
const MAX_FRAME: usize = 200;
const MAX_ROUTE: usize = 64;
const MAX_NAME: usize = 64;

/// An uncaught error as the page reports it.
#[derive(Debug, Clone, Deserialize)]
pub struct WebviewError {
    /// The error's constructor name, such as `TypeError`.
    pub name: String,
    pub message: String,
    pub frames: Vec<String>,
    /// The view the person was on.
    pub route: String,
    /// How many times it happened since it was last reported.
    pub count: u32,
}

/// Records the error as an `error` event on the `webview` target. The kind is the error's
/// name, kept only when it is a plain identifier so that text a page invents cannot become
/// a grouping key.
pub fn record_webview_error(error: &WebviewError) {
    let kind = if is_identifier(&error.name) {
        error.name.as_str()
    } else {
        "Error"
    };
    let frames = error
        .frames
        .iter()
        .take(MAX_FRAMES)
        .map(|frame| bounded(frame, MAX_FRAME))
        .collect::<Vec<_>>()
        .join("\n");
    tracing::error!(
        target: "webview",
        error_kind = kind,
        error = %bounded(&error.message, MAX_MESSAGE),
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

fn bounded(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}
