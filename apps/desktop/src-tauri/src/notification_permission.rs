//! One answer to "may ticketd show notifications?", and the one system ask.
//!
//! The notification plugin answers "granted" on every desktop whatever the
//! system says, so it is not asked. What each platform can report:
//! - macOS, running from the app bundle: allowed, not asked yet, or blocked,
//!   from Apple's notification center. Blocked opens System Settings.
//! - macOS from a terminal (a development build), Windows and Linux: nothing
//!   can be read, so the answer is allowed (what the plugin says) and the page
//!   never offers an ask or shows Blocked.
//!
//! The system is asked once: `request_notification_permission` shows the prompt
//! only while the status is "not asked yet".
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use ticketd_macos_notifications::{self as macos, Authorization};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    Allowed,
    NotAsked,
    Blocked,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct NotificationPermission {
    pub state: PermissionState,
    /// Whether the platform reports the permission. When false, `state` is the
    /// plugin's blanket "allowed" and nothing else can happen.
    pub reported: bool,
    /// Whether Open System Settings does anything on this platform.
    pub settings: bool,
}

/// What the operating system can be asked; a fake stands in for tests.
pub trait System {
    fn authorization(&self) -> Result<Authorization, macos::Error>;
    fn request(&self) -> Result<bool, macos::Error>;
}

struct Native;

impl System for Native {
    fn authorization(&self) -> Result<Authorization, macos::Error> {
        macos::authorization()
    }
    fn request(&self) -> Result<bool, macos::Error> {
        macos::request_authorization()
    }
}

fn read(system: &impl System) -> NotificationPermission {
    match system.authorization() {
        Ok(Authorization::Authorized) => reported(PermissionState::Allowed),
        Ok(Authorization::NotDetermined) => reported(PermissionState::NotAsked),
        Ok(Authorization::Denied) => reported(PermissionState::Blocked),
        // Nothing to read here, or the system did not answer: never invent a block.
        Err(_) => NotificationPermission {
            state: PermissionState::Allowed,
            reported: false,
            settings: false,
        },
    }
}

fn reported(state: PermissionState) -> NotificationPermission {
    NotificationPermission {
        state,
        reported: true,
        settings: cfg!(target_os = "macos"),
    }
}

/// Shows the system prompt only when it has not been shown, then reads again.
fn ask(system: &impl System) -> NotificationPermission {
    if read(system).state == PermissionState::NotAsked {
        let _ = system.request();
    }
    read(system)
}

/// The permission as the system reports it, without asking.
#[tauri::command]
pub async fn notification_permission() -> Result<NotificationPermission, String> {
    tauri::async_runtime::spawn_blocking(|| read(&Native))
        .await
        .map_err(|error| error.to_string())
}

/// Asks the system once; later calls only read the saved answer.
#[tauri::command]
pub async fn request_notification_permission() -> Result<NotificationPermission, String> {
    tauri::async_runtime::spawn_blocking(|| ask(&Native))
        .await
        .map_err(|error| error.to_string())
}

/// Opens the system's notification settings for the person to allow ticketd.
/// The address is fixed here, so the webview never supplies a URL.
#[tauri::command]
pub fn open_notification_settings(app: AppHandle) -> Result<(), String> {
    const MACOS: &str = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
    if !cfg!(target_os = "macos") {
        return Err("This system has no notification settings to open.".into());
    }
    app.opener()
        .open_url(MACOS, None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Fake {
        status: RefCell<Result<Authorization, macos::Error>>,
        grants: bool,
        asked: Cell<u32>,
    }

    impl Fake {
        fn new(status: Result<Authorization, macos::Error>, grants: bool) -> Self {
            Self {
                status: RefCell::new(status),
                grants,
                asked: Cell::new(0),
            }
        }
    }

    impl System for Fake {
        fn authorization(&self) -> Result<Authorization, macos::Error> {
            *self.status.borrow()
        }
        fn request(&self) -> Result<bool, macos::Error> {
            self.asked.set(self.asked.get() + 1);
            // The system remembers the answer, so the status changes with it.
            *self.status.borrow_mut() = Ok(if self.grants {
                Authorization::Authorized
            } else {
                Authorization::Denied
            });
            Ok(self.grants)
        }
    }

    #[test]
    fn each_system_status_maps_to_one_state() {
        for (status, state) in [
            (Authorization::Authorized, PermissionState::Allowed),
            (Authorization::NotDetermined, PermissionState::NotAsked),
            (Authorization::Denied, PermissionState::Blocked),
        ] {
            let permission = read(&Fake::new(Ok(status), true));
            assert_eq!(permission.state, state);
            assert!(permission.reported);
        }
    }

    #[test]
    fn where_nothing_can_be_read_it_is_allowed_and_unreported() {
        for failure in [macos::Error::Unavailable, macos::Error::TimedOut] {
            let permission = read(&Fake::new(Err(failure), true));
            assert_eq!(permission.state, PermissionState::Allowed);
            assert!(!permission.reported);
            assert!(!permission.settings);
        }
    }

    #[test]
    fn the_system_is_asked_once_and_the_answer_is_kept() {
        let system = Fake::new(Ok(Authorization::NotDetermined), false);
        assert_eq!(ask(&system).state, PermissionState::Blocked);
        assert_eq!(ask(&system).state, PermissionState::Blocked);
        assert_eq!(system.asked.get(), 1);
    }

    #[test]
    fn an_allowed_or_blocked_system_is_never_asked() {
        for status in [Authorization::Authorized, Authorization::Denied] {
            let system = Fake::new(Ok(status), true);
            ask(&system);
            assert_eq!(system.asked.get(), 0);
        }
        let unreadable = Fake::new(Err(macos::Error::Unavailable), true);
        ask(&unreadable);
        assert_eq!(unreadable.asked.get(), 0);
    }
}
