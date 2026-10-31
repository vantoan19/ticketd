#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> Result<(), tauri::Error> {
    ticketd_desktop_lib::run()
}
