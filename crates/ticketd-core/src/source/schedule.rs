//! Scheduling and in-process coordination of source refreshes.
//!
//! The desktop (and only a process that chooses to) asks a [`RefreshCoordinator`]
//! to refresh on startup and periodically; there is no daemon. The coordinator
//! owns three rules and nothing about the network or the database:
//!
//! - **One refresh at a time per process.** A periodic tick that finds a refresh
//!   running is skipped; a manual refresh waits for it and then runs.
//! - **No tight retry loop.** A failed run doubles the wait up to a ceiling, and a
//!   rate limit waits at least as long as the source asked. A success returns to
//!   the normal interval.
//! - **A rate limit survives a restart.** The first tick of a process honors the
//!   hold persisted by earlier runs (including the CLI's).
//!
//! Time comes from a [`Clock`], so schedules are deterministic in tests.
//! Processes (desktop, CLI) are not coordinated here: the refresh write is
//! atomic, identity-unique and ignores observations older than what it holds.

use std::{
    borrow::BorrowMut,
    collections::HashMap,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::{Engine, RefreshControl, RefreshOptions, RefreshReport, SourceError};
use crate::{Error, Workspace};

/// A source of "now" in whole seconds since the Unix epoch.
pub trait Clock: Send + Sync {
    fn now_secs(&self) -> u64;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefreshPolicy {
    /// Wait between successful runs.
    pub interval_secs: u64,
    /// The longest wait after consecutive failures.
    pub max_backoff_secs: u64,
}

impl Default for RefreshPolicy {
    fn default() -> Self {
        Self {
            interval_secs: 300,
            max_backoff_secs: 3600,
        }
    }
}

impl RefreshPolicy {
    fn delay_after_run(self, failures: &mut u32, failed: bool, retry_after: u64) -> u64 {
        if !failed {
            *failures = 0;
            return self.interval_secs;
        }
        *failures = failures.saturating_add(1);
        self.interval_secs
            .saturating_mul(1_u64 << (*failures).min(20))
            .min(self.max_backoff_secs)
            .max(retry_after)
    }
}

/// Why a scheduled tick did not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// Another refresh is in progress.
    Running,
    /// The next run is not due yet.
    NotDue { in_secs: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Run<T> {
    Ran(T),
    Skipped(Skip),
}

struct State {
    running: bool,
    next_due: u64,
    failures: u32,
    connections: HashMap<String, ConnectionSchedule>,
}

struct ConnectionSchedule {
    next_due: u64,
    failures: u32,
}

pub struct RefreshCoordinator {
    clock: Arc<dyn Clock>,
    policy: RefreshPolicy,
    state: Mutex<State>,
    idle: Condvar,
}

/// Marks the coordinator idle again even if the work panics.
struct Running<'a>(&'a RefreshCoordinator);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let mut state = self.0.lock();
        state.running = false;
        self.0.idle.notify_all();
    }
}

fn timestamp(seconds: u64) -> Option<String> {
    i64::try_from(seconds)
        .ok()
        .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

impl RefreshCoordinator {
    /// The first scheduled tick is due immediately (desktop startup).
    pub fn new(clock: Arc<dyn Clock>, policy: RefreshPolicy) -> Self {
        let next_due = clock.now_secs();
        Self {
            clock,
            policy,
            state: Mutex::new(State {
                running: false,
                next_due,
                failures: 0,
                connections: HashMap::new(),
            }),
            idle: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn is_refreshing(&self) -> bool {
        self.lock().running
    }

    /// Runs `work` when nothing is running and the schedule says it is due.
    pub fn run_if_due(
        &self,
        work: impl FnOnce() -> Result<RefreshReport, Error>,
    ) -> Result<Run<RefreshReport>, Error> {
        {
            let mut state = self.lock();
            if state.running {
                return Ok(Run::Skipped(Skip::Running));
            }
            let now = self.clock.now_secs();
            if now < state.next_due {
                return Ok(Run::Skipped(Skip::NotDue {
                    in_secs: state.next_due - now,
                }));
            }
            state.running = true;
        }
        self.execute(work).map(Run::Ran)
    }

    /// Runs `work` now for an explicit request, after any running refresh finishes.
    /// An explicit request ignores the schedule but still feeds it.
    pub fn run_now(
        &self,
        work: impl FnOnce() -> Result<RefreshReport, Error>,
    ) -> Result<RefreshReport, Error> {
        self.run_explicit(true, None, work)
    }

    /// Like [`Self::run_now`]. A run that covers one ticket only (`feeds_schedule`
    /// false) says nothing about the source as a whole, so it neither resets nor
    /// extends the schedule of the full refresh.
    fn run_explicit(
        &self,
        feeds_schedule: bool,
        control: Option<&RefreshControl>,
        work: impl FnOnce() -> Result<RefreshReport, Error>,
    ) -> Result<RefreshReport, Error> {
        {
            let mut state = self.lock();
            while state.running {
                state = if let Some(control) = control {
                    control.check()?;
                    self.idle
                        .wait_timeout(state, Duration::from_millis(100))
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .0
                } else {
                    self.idle
                        .wait(state)
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                };
            }
            if let Some(control) = control {
                control.check()?;
            }
            state.running = true;
        }
        if feeds_schedule {
            self.execute(work)
        } else {
            let _running = Running(self);
            work()
        }
    }

    fn execute(
        &self,
        work: impl FnOnce() -> Result<RefreshReport, Error>,
    ) -> Result<RefreshReport, Error> {
        let _running = Running(self);
        let result = work();
        if !matches!(result, Err(Error::Source(SourceError::RefreshCanceled))) {
            let mut state = self.lock();
            let failed = result
                .as_ref()
                .map_or(true, RefreshReport::interrupted_by_source);
            let retry_after = result
                .as_ref()
                .ok()
                .and_then(RefreshReport::retry_after_secs)
                .unwrap_or(0);
            let wait = self
                .policy
                .delay_after_run(&mut state.failures, failed, retry_after);
            state.next_due = self.clock.now_secs().saturating_add(wait);
        }
        result
    }

    /// Refreshes only connections that are due. The first connection starts
    /// immediately; the others join at two-second intervals on startup.
    pub fn tick<W: BorrowMut<Workspace>>(
        &self,
        engine: &Engine,
        open: &dyn Fn() -> Result<W, Error>,
    ) -> Result<Run<RefreshReport>, Error> {
        if self.is_refreshing() {
            return Ok(Run::Skipped(Skip::Running));
        }
        let mut workspace = open()?;
        let workspace = workspace.borrow_mut();
        let now = self.clock.now_secs();
        let saved = workspace.saved_sources()?;
        let statuses = workspace.source_statuses()?;
        let due = {
            let mut state = self.lock();
            if state.running {
                return Ok(Run::Skipped(Skip::Running));
            }
            let mut due = Vec::new();
            let mut wait = u64::MAX;
            for (index, source) in saved.into_iter().enumerate() {
                let hold = statuses
                    .iter()
                    .find(|status| status.connection_id.as_deref() == Some(&source.id))
                    .and_then(|status| status.retry_after.as_deref())
                    .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
                    .and_then(|time| u64::try_from(time.timestamp()).ok())
                    .unwrap_or(0);
                let schedule = state
                    .connections
                    .entry(source.id.clone())
                    .or_insert_with(|| ConnectionSchedule {
                        next_due: now.saturating_add(
                            u64::try_from(index).unwrap_or(u64::MAX).saturating_mul(2),
                        ),
                        failures: 0,
                    });
                let next = schedule.next_due.max(hold);
                if now >= next {
                    due.push(source.id);
                } else {
                    wait = wait.min(next - now);
                }
            }
            if due.is_empty() {
                return Ok(Run::Skipped(Skip::NotDue {
                    in_secs: if wait == u64::MAX {
                        self.policy.interval_secs
                    } else {
                        wait
                    },
                }));
            }
            state.running = true;
            due
        };
        let _running = Running(self);
        let options = RefreshOptions {
            ticket: None,
            now: timestamp(now),
        };
        let result = workspace.refresh_selected(engine, &options, Some(&due));
        self.feed_connections(&due, &result);
        result.map(Run::Ran)
    }

    /// An explicit refresh of everything, or of one ticket by reference.
    pub fn refresh_now<W: BorrowMut<Workspace>>(
        &self,
        engine: &Engine,
        open: &dyn Fn() -> Result<W, Error>,
        ticket: Option<&str>,
    ) -> Result<RefreshReport, Error> {
        self.refresh_connection_now(engine, open, None, ticket)
    }

    pub fn refresh_connection_now<W: BorrowMut<Workspace>>(
        &self,
        engine: &Engine,
        open: &dyn Fn() -> Result<W, Error>,
        connection: Option<&str>,
        ticket: Option<&str>,
    ) -> Result<RefreshReport, Error> {
        self.run_explicit(false, engine.refresh_control(), || {
            let mut workspace = open()?;
            let workspace = workspace.borrow_mut();
            let options = RefreshOptions {
                ticket: ticket.map(str::to_owned),
                now: timestamp(self.clock.now_secs()),
            };
            let due = if let Some(id) = connection {
                vec![id.to_owned()]
            } else {
                workspace
                    .saved_sources()?
                    .into_iter()
                    .map(|source| source.id)
                    .collect()
            };
            let result = if let Some(id) = connection {
                workspace.refresh_connection(engine, id, &options)
            } else {
                workspace.refresh_sources(engine, &options)
            };
            if ticket.is_none() {
                self.feed_connections(&due, &result);
            }
            result
        })
    }

    fn feed_connections(&self, due: &[String], result: &Result<RefreshReport, Error>) {
        if matches!(result, Err(Error::Source(SourceError::RefreshCanceled))) {
            return;
        }
        let now = self.clock.now_secs();
        let mut state = self.lock();
        for id in due {
            let schedule = state
                .connections
                .entry(id.clone())
                .or_insert(ConnectionSchedule {
                    next_due: now,
                    failures: 0,
                });
            let failure = result.as_ref().ok().and_then(|report| {
                report.failures.iter().find(|failure| {
                    failure.connection_id.as_deref() == Some(id) && failure.interrupts()
                })
            });
            let wait = self.policy.delay_after_run(
                &mut schedule.failures,
                failure.is_some() || result.is_err(),
                failure
                    .and_then(|failure| failure.retry_after_secs)
                    .unwrap_or(0),
            );
            schedule.next_due = now.saturating_add(wait);
        }
    }
}
