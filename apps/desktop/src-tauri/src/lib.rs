//! Desktop adapter for the shared ticketd core.

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default().run(tauri::generate_context!())
}
