//! Hands GTK's typed clipboard files to the same WebKit input as picked files.

use gtk::prelude::WidgetExt;
use webkit2gtk::{FileChooserRequestExt, WebView, WebViewExt};

const CLIPBOARD_FILE_PICKER: &str = "application/x-ticketd-clipboard";

pub(crate) fn install(view: &WebView, dev_url: Option<tauri::Url>) {
    view.connect_run_file_chooser(move |view, request| {
        if !request.selects_multiple()
            || !request
                .mime_types()
                .iter()
                .any(|kind| kind == CLIPBOARD_FILE_PICKER)
        {
            return false;
        }
        let app_page = view
            .uri()
            .and_then(|uri| tauri::Url::parse(&uri).ok())
            .is_some_and(|url| {
                (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || dev_url
                        .as_ref()
                        .is_some_and(|dev| url.origin() == dev.origin())
            });
        if !app_page {
            return false;
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
