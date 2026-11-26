//! What macOS says about ticketd's notifications, and the one system ask.
//!
//! The Tauri notification plugin answers "granted" on desktop whatever the
//! system says, so it cannot tell a person who has not been asked from one who
//! turned ticketd off in System Settings. Apple's notification center can, but
//! only for a process that runs from an app bundle: elsewhere (a development
//! build from the terminal) it raises an exception, so both calls refuse to ask
//! it and say so.

use std::fmt;

/// The authorization status Apple reports for the app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authorization {
    /// The system has never been asked.
    NotDetermined,
    /// The person turned notifications off for ticketd.
    Denied,
    /// Notifications are allowed (including provisional and ephemeral grants).
    Authorized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// This process cannot ask: not macOS, or not running from an app bundle.
    Unavailable,
    /// The notification center did not answer in time.
    TimedOut,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "the system does not report notification permission here",
            Self::TimedOut => "the system did not answer about notification permission",
        })
    }
}

impl std::error::Error for Error {}

/// Reads the status without asking. Blocks until the system answers.
pub fn authorization() -> Result<Authorization, Error> {
    imp::authorization()
}

/// Shows the system's permission prompt, which it does once; a later call
/// resolves from the saved answer. Returns whether notifications are allowed.
/// Blocks until the person answers.
pub fn request_authorization() -> Result<bool, Error> {
    imp::request_authorization()
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{Authorization, Error};

    pub fn authorization() -> Result<Authorization, Error> {
        Err(Error::Unavailable)
    }

    pub fn request_authorization() -> Result<bool, Error> {
        Err(Error::Unavailable)
    }
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod imp {
    use super::{Authorization, Error};
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSBundle, NSError};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNNotificationSettings,
        UNUserNotificationCenter,
    };
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    /// A person may take a while over the prompt; a status read is instant.
    const READ_WAIT: Duration = Duration::from_secs(5);
    const ASK_WAIT: Duration = Duration::from_secs(10 * 60);

    /// `UNUserNotificationCenter` raises an Objective-C exception, which aborts
    /// the process, when the executable is not inside an app bundle.
    fn bundled() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    }

    fn map(status: UNAuthorizationStatus) -> Authorization {
        if status == UNAuthorizationStatus::NotDetermined {
            Authorization::NotDetermined
        } else if status == UNAuthorizationStatus::Denied {
            Authorization::Denied
        } else {
            Authorization::Authorized
        }
    }

    pub fn authorization() -> Result<Authorization, Error> {
        if !bundled() {
            return Err(Error::Unavailable);
        }
        let (send, receive) = mpsc::channel();
        let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: the system passes a valid settings object that lives for
            // the duration of this callback, and the status is read inside it.
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let _ = send.send(map(status));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .getNotificationSettingsWithCompletionHandler(&handler);
        receive.recv_timeout(READ_WAIT).map_err(|_| Error::TimedOut)
    }

    pub fn request_authorization() -> Result<bool, Error> {
        if !bundled() {
            return Err(Error::Unavailable);
        }
        let (send, receive) = mpsc::channel();
        let handler = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            let _ = send.send(granted.as_bool());
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &handler,
            );
        receive.recv_timeout(ASK_WAIT).map_err(|_| Error::TimedOut)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test runs are not app bundles, so nothing here may reach the system.
    #[test]
    fn outside_an_app_bundle_the_system_is_never_asked() {
        assert_eq!(authorization(), Err(Error::Unavailable));
        assert_eq!(request_authorization(), Err(Error::Unavailable));
    }
}
