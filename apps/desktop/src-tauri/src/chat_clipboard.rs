//! Hands GTK's clipboard snapshots to a composer paste WebKit has redacted.

use gtk::prelude::WidgetExt;
use webkit2gtk::{FileChooserRequest, FileChooserRequestExt, WebView, WebViewExt};

const CLIPBOARD_FILE_PICKER: &str = "application/x-ticketd-clipboard";
const CLIPBOARD_IMAGE_PICKER: &str = "application/x-ticketd-clipboard-image-";

fn app_page(view: &WebView, dev_url: Option<&tauri::Url>) -> Option<tauri::Url> {
    view.uri()
        .and_then(|uri| tauri::Url::parse(&uri).ok())
        .filter(|url| {
            (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || dev_url.is_some_and(|dev| url.origin() == dev.origin())
        })
}

fn clipboard_image(
    view: &WebView,
    request: &FileChooserRequest,
    page: &tauri::Url,
    id: uuid::Uuid,
) {
    let clipboard = gtk::Clipboard::default(&view.display());
    let request = request.clone();
    let view = view.clone();
    let page = page.to_string();
    let finish = move |result: Result<
        Option<ticketd_core::ChatAttachmentContent>,
        ticketd_core::Error,
    >| {
        let payload = match result {
            Ok(Some(file)) => serde_json::json!({
                "id": id,
                "attachment": { "name": file.name(), "dataUrl": file.data_url() },
            }),
            Ok(None) => serde_json::json!({ "id": id }),
            Err(error) => serde_json::json!({ "id": id, "error": error.to_string() }),
        };
        // The chooser and the reply both belong to the app page. Compare the
        // protocol and host explicitly because a custom URL has an opaque origin.
        let page = serde_json::json!(page);
        let script = format!(
            concat!(
                "if (location.protocol === new URL({0}).protocol && location.host === new URL({0}).host) ",
                "window.dispatchEvent(new CustomEvent('ticketd-clipboard-image', {{ detail: {1} }}));"
            ),
            page, payload,
        );
        view.evaluate_javascript(&script, None, None, None::<&gtk::gio::Cancellable>, |_| {});
        request.cancel();
    };
    let Some(clipboard) = clipboard else {
        finish(Ok(None));
        return;
    };
    let png = gtk::gdk::Atom::intern("image/png");
    clipboard.request_contents(
        &gtk::gdk::Atom::intern("TARGETS"),
        move |clipboard, selection| {
            if !selection
                .targets()
                .is_some_and(|targets| targets.contains(&png))
            {
                finish(Ok(None));
                return;
            }
            clipboard.request_contents(&png, move |_, selection| {
                let result = (|| {
                    let length = selection.length();
                    if length <= 0 || selection.data_type() != png {
                        return Ok(None);
                    }
                    let limit = crate::open_workspace()?.attachment_upload_limit()?;
                    if length as u64 > limit {
                        return Err(ticketd_core::Error::UploadLimit { limit });
                    }
                    ticketd_core::ChatAttachmentContent::from_clipboard_png(selection.data(), limit)
                        .map(Some)
                })();
                finish(result);
            });
        },
    );
}

pub(crate) fn install(view: &WebView, dev_url: Option<tauri::Url>) {
    view.connect_run_file_chooser(move |view, request| {
        if !request.selects_multiple() {
            return false;
        }
        let types = request.mime_types();
        let image = types.iter().find_map(|kind| {
            kind.strip_prefix(CLIPBOARD_IMAGE_PICKER)
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
        });
        if image.is_none() && !types.iter().any(|kind| kind == CLIPBOARD_FILE_PICKER) {
            return false;
        }
        let Some(page) = app_page(view, dev_url.as_ref()) else {
            return false;
        };
        if let Some(id) = image {
            clipboard_image(view, request, &page, id);
            return true;
        }
        let Some(clipboard) = gtk::Clipboard::default(&view.display()) else {
            request.cancel();
            return true;
        };

        let request = request.clone();
        clipboard.request_uris(move |_, uris| {
            let paths: Vec<_> = uris
                .iter()
                .filter_map(|uri| gtk::glib::filename_from_uri(uri).ok())
                .filter(|(_, host)| {
                    host.as_ref()
                        .is_none_or(|host| host.eq_ignore_ascii_case("localhost"))
                })
                .map(|(path, _)| path)
                .collect();
            let files: Vec<_> = paths.iter().filter_map(|path| path.to_str()).collect();
            if files.is_empty() {
                request.cancel();
            } else {
                request.select_files(&files);
            }
        });
        true
    });
}
