//! Wakes the desktop's background loops (sync, reminders, the Automation runner)
//! when something they follow may have changed, so they can sleep the rest of the
//! time. There is no change feed (ADR 0013): the desktop learns that the Workspace
//! changed when the interface's change poll sees the token move, and from its own
//! commands that change what a loop follows. Each loop still wakes on its own
//! deadline, at least every [`IDLE`], for changes nothing reported.

use std::sync::{Condvar, Mutex, PoisonError};
use std::time::Duration;

/// The longest a background loop sleeps with nothing due.
pub const IDLE: Duration = Duration::from_secs(30);

/// Counts notifications, so a loop that was busy when one came still sees it.
pub struct Signal {
    count: Mutex<u64>,
    changed: Condvar,
}

impl Signal {
    pub const fn new() -> Self {
        Self {
            count: Mutex::new(0),
            changed: Condvar::new(),
        }
    }

    pub fn notify(&self) {
        *self.count.lock().unwrap_or_else(PoisonError::into_inner) += 1;
        self.changed.notify_all();
    }

    /// Returns once notified after the last notification `seen` counted, or when
    /// `timeout` has passed, and counts what it saw.
    pub fn wait(&self, seen: &mut u64, timeout: Duration) {
        let count = self.count.lock().unwrap_or_else(PoisonError::into_inner);
        let (count, _) = self
            .changed
            .wait_timeout_while(count, timeout, |count| *count == *seen)
            .unwrap_or_else(PoisonError::into_inner);
        *seen = *count;
    }
}

/// The Workspace, or what a background loop follows, may have changed.
pub static CHANGED: Signal = Signal::new();

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn a_notification_wakes_a_loop_even_if_it_came_while_the_loop_was_busy() {
        let signal = Signal::new();
        let mut seen = 0;
        signal.notify();
        let started = Instant::now();
        signal.wait(&mut seen, Duration::from_secs(10));
        assert!(started.elapsed() < Duration::from_secs(5));

        // Counted: the next wait sleeps until its timeout.
        let started = Instant::now();
        signal.wait(&mut seen, Duration::from_millis(50));
        assert!(started.elapsed() >= Duration::from_millis(50));
    }
}
