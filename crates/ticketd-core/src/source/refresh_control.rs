//! In-memory controls for one explicit refresh.

use serde::Serialize;
use tokio::sync::watch;

use super::SourceError;

/// The count reported by a source extension during its current call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RefreshProgress {
    pub completed: u32,
    pub total: Option<u32>,
}

#[derive(Clone)]
pub struct RefreshControl {
    canceled: watch::Sender<bool>,
    progress: watch::Sender<Option<RefreshProgress>>,
    cancel_on_progress: bool,
    acknowledged: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Default for RefreshControl {
    fn default() -> Self {
        Self {
            canceled: watch::channel(false).0,
            progress: watch::channel(None).0,
            cancel_on_progress: false,
            acknowledged: Default::default(),
        }
    }
}

impl RefreshControl {
    pub fn cancel(&self) {
        self.canceled.send_replace(true);
    }

    /// Reports the latest count. Slow clients can skip intermediate updates.
    pub fn progress(&self) -> watch::Receiver<Option<RefreshProgress>> {
        self.progress.subscribe()
    }

    pub(super) fn check(&self) -> Result<(), SourceError> {
        if *self.canceled.borrow() {
            return Err(SourceError::RefreshCanceled);
        }
        Ok(())
    }

    pub(super) async fn canceled(&self) {
        let _ = self.canceled.subscribe().wait_for(|cancel| *cancel).await;
    }

    pub(super) fn report(&self, progress: RefreshProgress) {
        self.progress.send_if_modified(|last| {
            if *last == Some(progress) {
                return false;
            }
            *last = Some(progress);
            true
        });
        if self.cancel_on_progress {
            self.cancel();
        }
    }

    pub(super) fn cancellation_probe() -> Self {
        Self {
            cancel_on_progress: true,
            ..Self::default()
        }
    }

    pub(super) fn acknowledge(&self) {
        use std::sync::atomic::Ordering;
        self.acknowledged.store(true, Ordering::Relaxed);
    }

    pub(super) fn acknowledged(&self) -> bool {
        use std::sync::atomic::Ordering;
        self.acknowledged.load(Ordering::Relaxed)
    }
}
