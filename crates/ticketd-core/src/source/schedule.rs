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
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use super::{Engine, RefreshOptions, RefreshReport};
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
    hold_loaded: bool,
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
                hold_loaded: false,
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
        self.run_explicit(true, work)
    }

    /// Like [`Self::run_now`]. A run that covers one ticket only (`feeds_schedule`
    /// false) says nothing about the source as a whole, so it neither resets nor
    /// extends the schedule of the full refresh.
    fn run_explicit(
        &self,
        feeds_schedule: bool,
        work: impl FnOnce() -> Result<RefreshReport, Error>,
    ) -> Result<RefreshReport, Error> {
        {
            let mut state = self.lock();
            while state.running {
                state = self
                    .idle
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let now = self.clock.now_secs();
        let mut state = self.lock();
        match &result {
            Ok(report) if !report.interrupted_by_source() => {
                state.failures = 0;
                state.next_due = now + self.policy.interval_secs;
            }
            other => {
                state.failures = state.failures.saturating_add(1);
                let doubled = self
                    .policy
                    .interval_secs
                    .saturating_mul(1_u64 << state.failures.min(20));
                let mut wait = doubled.min(self.policy.max_backoff_secs);
                if let Ok(report) = other {
                    wait = wait.max(report.retry_after_secs().unwrap_or(0));
                }
                state.next_due = now + wait;
            }
        }
        drop(state);
        result
    }

    /// One scheduled tick against a workspace opened on demand, so nothing is
    /// held between ticks. The first tick of a process also honors a rate-limit
    /// hold persisted by earlier runs.
    pub fn tick(
        &self,
        engine: &Engine,
        open: &dyn Fn() -> Result<Workspace, Error>,
    ) -> Result<Run<RefreshReport>, Error> {
        self.load_hold(open)?;
        self.run_if_due(|| open()?.refresh_sources(engine, &RefreshOptions::default()))
    }

    /// An explicit refresh of everything, or of one ticket by reference.
    pub fn refresh_now(
        &self,
        engine: &Engine,
        open: &dyn Fn() -> Result<Workspace, Error>,
        ticket: Option<&str>,
    ) -> Result<RefreshReport, Error> {
        self.run_explicit(ticket.is_none(), || {
            open()?.refresh_sources(
                engine,
                &RefreshOptions {
                    ticket: ticket.map(str::to_owned),
                    now: None,
                },
            )
        })
    }

    fn load_hold(&self, open: &dyn Fn() -> Result<Workspace, Error>) -> Result<(), Error> {
        if self.lock().hold_loaded {
            return Ok(());
        }
        let hold = open()?.source_hold_until()?;
        let mut state = self.lock();
        if !state.hold_loaded {
            state.hold_loaded = true;
            if let Some(until) = hold {
                state.next_due = state.next_due.max(until);
            }
        }
        Ok(())
    }
}
