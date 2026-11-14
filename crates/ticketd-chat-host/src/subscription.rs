//! A view's bounded feed of one Chat. A view that falls behind is told to resync
//! instead of holding an unbounded backlog.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use ticketd_core::ChatChange;
use tokio::sync::Notify;

use crate::host::ChatLive;

/// Provisional bounds, to be measured in #267.
pub const SUBSCRIBER_BACKLOG_ITEMS: usize = 1_000;
pub const SUBSCRIBER_BACKLOG_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatUpdate {
    /// Committed records in change order. Apply as upserts keyed by ID.
    Changes(Vec<ChatChange>),
    /// Streamed assistant text not yet committed. Append `delta` to the message; a later
    /// change for the same message replaces its text.
    Text {
        message_id: String,
        turn_id: String,
        delta: String,
    },
    /// State that exists only while the host runs. Boxed: it is far larger than the
    /// other updates.
    Live(Box<ChatLive>),
    /// The view fell behind. This is the last update; attach again for a new snapshot.
    Resync,
}

impl ChatUpdate {
    fn bytes(&self) -> usize {
        match self {
            // ponytail: serializes once more than the bridge will; estimate if it shows up in profiles.
            Self::Changes(changes) => serde_json::to_vec(changes).map_or(0, |json| json.len()),
            Self::Text { delta, .. } => delta.len(),
            Self::Live(_) | Self::Resync => 256,
        }
    }
}

#[derive(Debug, Default)]
struct Backlog {
    updates: VecDeque<(ChatUpdate, usize)>,
    bytes: usize,
    closed: bool,
}

#[derive(Debug, Default)]
struct Shared {
    backlog: Mutex<Backlog>,
    wake: Notify,
}

impl Shared {
    fn backlog(&self) -> MutexGuard<'_, Backlog> {
        self.backlog.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The view's end. Dropping it detaches the view; the Chat keeps running.
#[derive(Debug)]
pub struct Subscription {
    shared: Arc<Shared>,
}

impl Subscription {
    /// The next update, or `None` once the feed has ended.
    pub async fn next(&mut self) -> Option<ChatUpdate> {
        loop {
            {
                let mut backlog = self.shared.backlog();
                if let Some((update, bytes)) = backlog.updates.pop_front() {
                    backlog.bytes -= bytes;
                    return Some(update);
                }
                if backlog.closed {
                    return None;
                }
            }
            self.shared.wake.notified().await;
        }
    }
}

#[derive(Debug)]
pub(crate) struct Publisher {
    shared: Arc<Shared>,
}

pub(crate) fn channel() -> (Publisher, Subscription) {
    let shared = Arc::new(Shared::default());
    (
        Publisher {
            shared: shared.clone(),
        },
        Subscription { shared },
    )
}

impl Drop for Publisher {
    /// A supervisor that ends, however it ends, ends its views' feeds: what is already
    /// queued is still delivered, then `next` returns `None`.
    fn drop(&mut self) {
        self.shared.backlog().closed = true;
        self.shared.wake.notify_one();
    }
}

impl Publisher {
    /// False once the view is gone or was told to resync.
    pub(crate) fn open(&self) -> bool {
        Arc::strong_count(&self.shared) > 1 && !self.shared.backlog().closed
    }

    pub(crate) fn push(&self, update: ChatUpdate) {
        let bytes = update.bytes();
        let mut backlog = self.shared.backlog();
        if backlog.closed {
            return;
        }
        if backlog.updates.len() >= SUBSCRIBER_BACKLOG_ITEMS
            || backlog.bytes + bytes > SUBSCRIBER_BACKLOG_BYTES
        {
            backlog.updates.clear();
            backlog.updates.push_back((ChatUpdate::Resync, 0));
            backlog.bytes = 0;
            backlog.closed = true;
        } else {
            backlog.updates.push_back((update, bytes));
            backlog.bytes += bytes;
        }
        drop(backlog);
        self.shared.wake.notify_one();
    }

    pub(crate) fn resync(&self) {
        let mut backlog = self.shared.backlog();
        backlog.updates.clear();
        backlog.updates.push_back((ChatUpdate::Resync, 0));
        backlog.bytes = 0;
        backlog.closed = true;
        drop(backlog);
        self.shared.wake.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(bytes: usize) -> ChatUpdate {
        ChatUpdate::Text {
            message_id: "m".to_owned(),
            turn_id: "t".to_owned(),
            delta: "x".repeat(bytes),
        }
    }

    #[tokio::test]
    async fn a_backlog_over_the_byte_bound_is_replaced_by_one_resync() {
        let (publisher, mut subscription) = channel();
        publisher.push(text(SUBSCRIBER_BACKLOG_BYTES));
        assert!(publisher.open());

        publisher.push(text(1));

        assert!(!publisher.open());
        assert_eq!(subscription.next().await, Some(ChatUpdate::Resync));
        assert_eq!(subscription.next().await, None);
    }

    #[tokio::test]
    async fn a_feed_ends_when_its_publisher_is_dropped() {
        let (publisher, mut subscription) = channel();
        publisher.push(text(1));
        let waiting = tokio::spawn(async move {
            let first = subscription.next().await;
            (first, subscription.next().await)
        });

        drop(publisher);

        let (first, second) = waiting.await.expect("the reader finishes");
        assert_eq!(first, Some(text(1)));
        assert_eq!(second, None);
    }
}
