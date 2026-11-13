//! Which Chats need the person, which hold something they have not seen, and when the
//! system is told (spec 21.3). Every surface reads one ranked status per Chat: the list
//! row, the sidebar count, the app-icon count and system notifications.
//!
//! Nothing here touches Tauri; the desktop shows what `Notifier` decides.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::conditions::ChatProblemKind;
use crate::{ChatLive, InteractionKind, STOPPED_BY_TICKETD, problem_kind};
use serde::Serialize;
use ticketd_core::{Chat, ChatAgentChange, ChatTurn, ChatTurnState};

/// How long "Done" waits before it notifies, so a turn that continues at once does not.
pub const QUIET_WINDOW: Duration = Duration::from_millis(1500);

/// Highest first: a Chat shows only its top status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Rank {
    Approval,
    Question,
    Working,
    /// Shown until seen; a seen failure is Idle.
    Failed,
    /// Shown until seen.
    Done,
    Idle,
}

impl Rank {
    /// Waits for the person: counted on the sidebar and the app icon, notified at once.
    pub fn needs_you(self) -> bool {
        matches!(self, Self::Approval | Self::Question | Self::Failed)
    }
}

/// A Chat's ranked status and the words its row's second line says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub rank: Rank,
    /// The last turn ended after the person last saw the Chat, or they marked it unread.
    pub unseen: bool,
    /// "Approval needed", "Working", or for Idle the plain last line ("You stopped it").
    pub word: String,
    /// What it is about; truncated first.
    pub detail: Option<String>,
}

impl Status {
    /// Unseen, and not already counted as waiting: the blue dot.
    pub fn unread(&self) -> bool {
        self.unseen && matches!(self.rank, Rank::Done | Rank::Idle)
    }

    /// The row's second line, as a notification body says it.
    pub fn line(&self) -> String {
        match &self.detail {
            Some(detail) => format!("{} · {detail}", self.word),
            None => self.word.clone(),
        }
    }
}

/// What the status is computed from, as the Chat view knows it.
pub struct Facts<'a> {
    pub chat: &'a Chat,
    pub harness: &'a str,
    pub live: &'a ChatLive,
    /// The latest turn recorded, active or ended.
    pub last_turn: Option<&'a ChatTurn>,
    /// The text of input whose delivery the person has to decide about.
    pub uncertain: Option<&'a str>,
    /// The Chat's problem, and whether it is why the last turn stopped.
    pub problem: Option<(ChatProblemKind, bool)>,
    /// A failure observed now, in words, for a problem of kind `failed`.
    pub failure: Option<&'a str>,
    pub activity: &'a str,
    pub opening: bool,
    pub last_change: Option<&'a ChatAgentChange>,
    pub last_response: Option<&'a str>,
}

/// What the agent did to a record, verb first.
pub fn change_line(change: &ChatAgentChange) -> String {
    match change {
        ChatAgentChange::Status { reference, to, .. } => format!("Moved {reference} to {to}"),
        ChatAgentChange::Update { reference, .. } => format!("Posted an update on {reference}"),
    }
}

/// The first line of Markdown as plain words, for a one-line detail.
fn plain_start(markdown: &str) -> Option<String> {
    let line = markdown
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let line = line
        .trim_start_matches(['#', '>', ' '])
        .trim_start_matches("- ")
        .trim_start_matches("* ");
    let mut text = String::new();
    let mut rest = line;
    // `[label](target)` reads as its label.
    while let Some(open) = rest.find('[') {
        let (before, after) = rest.split_at(open);
        text.push_str(before);
        match after.find("](").zip(after.find(')')) {
            Some((middle, close)) if middle < close => {
                text.push_str(&after[1..middle]);
                rest = &after[close + 1..];
            }
            _ => {
                text.push('[');
                rest = &after[1..];
            }
        }
    }
    text.push_str(rest);
    let text = text.replace(['`'], "").replace("**", "").replace("__", "");
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(140).collect())
}

/// Why a turn ended with an error, in a few words: what its notice is titled.
fn failure_detail(turn: &ChatTurn, harness: &str) -> String {
    turn.problem
        .as_deref()
        .map_or(ChatProblemKind::Failed, |key| problem_kind(key).into())
        .title(harness, true)
}

pub fn status(facts: &Facts<'_>) -> Status {
    let ended = facts
        .last_turn
        .filter(|turn| turn.state != ChatTurnState::Active);
    let unseen = ended.is_some_and(|turn| facts.chat.unseen(turn));
    let make = |rank, word: &str, detail: Option<String>| Status {
        rank,
        unseen,
        word: word.to_owned(),
        detail,
    };
    let requests = &facts.live.interactions;
    let approval = requests.iter().find_map(|request| match &request.kind {
        InteractionKind::Approval { description, .. } => Some(description),
        InteractionKind::Question { .. } => None,
    });
    if let Some(description) = approval {
        return make(Rank::Approval, "Approval needed", plain_start(description));
    }
    let question = requests.iter().find_map(|request| match &request.kind {
        InteractionKind::Question { questions } => {
            Some(questions.first().map(|question| question.prompt.as_str()))
        }
        InteractionKind::Approval { .. } => None,
    });
    if let Some(prompt) = question {
        return make(Rank::Question, "Question", prompt.and_then(plain_start));
    }
    if let Some(text) = facts.uncertain {
        return make(Rank::Question, "Not confirmed", plain_start(text));
    }
    if facts
        .problem
        .is_some_and(|(kind, _)| kind == ChatProblemKind::StopUnconfirmed)
    {
        return make(Rank::Working, "Stop not confirmed", None);
    }
    if matches!(facts.activity, "working" | "waiting") {
        return make(
            Rank::Working,
            "Working",
            facts.opening.then(|| "Starting".to_owned()),
        );
    }
    if facts.problem == Some((ChatProblemKind::Failed, false)) {
        return make(Rank::Failed, "Failed", facts.failure.map(str::to_owned));
    }
    let done = || {
        facts
            .last_change
            .map(change_line)
            .or_else(|| facts.last_response.and_then(plain_start))
    };
    let outcome = ended.map(|turn| match turn.state {
        ChatTurnState::Completed => (Rank::Done, "Done".to_owned(), done()),
        ChatTurnState::Failed => (
            Rank::Failed,
            "Failed".to_owned(),
            Some(failure_detail(turn, facts.harness)),
        ),
        ChatTurnState::Unknown if turn.detail.as_deref() == Some(STOPPED_BY_TICKETD) => {
            (Rank::Idle, "Stopped when ticketd quit".to_owned(), None)
        }
        ChatTurnState::Unknown => (
            Rank::Failed,
            "Interrupted".to_owned(),
            Some(format!("{} stopped mid-turn", facts.harness)),
        ),
        ChatTurnState::Interrupted | ChatTurnState::Active => {
            (Rank::Idle, "You stopped it".to_owned(), None)
        }
    });
    if let Some((rank, word, detail)) = outcome.clone().filter(|_| unseen) {
        return make(rank, &word, detail);
    }
    // Seen, or nothing ended: the last line in words.
    let condition = facts
        .problem
        .filter(|(_, past)| !past)
        .and_then(|(kind, _)| kind.condition_word());
    if let Some(words) = condition {
        return make(Rank::Idle, words, None);
    }
    match outcome {
        Some((Rank::Done, _, Some(line))) => make(Rank::Idle, &line, None),
        Some((Rank::Done, _, None)) | None => make(Rank::Idle, "Idle", None),
        Some((_, word, detail)) => make(Rank::Idle, &word, detail),
    }
}

/// One Chat as the notifier sees it.
pub struct Row<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub status: &'a Status,
    pub muted: bool,
}

/// What to do with the system's notifications.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Alert {
    /// Shown for the Chat, replacing its older one.
    Show {
        chat_id: String,
        title: String,
        body: String,
    },
    /// The Chat's notification no longer holds: it was answered, expired or seen.
    Withdraw { chat_id: String },
}

/// Decides when a Chat is announced. A Chat in view never is; "Done" waits out the
/// quiet window; requests and failures are told at once, each once.
#[derive(Debug, Default)]
pub struct Notifier {
    /// The status each Chat was last seen in. `None` until the first update, which
    /// announces nothing: what was there at startup was already shown or is old.
    last: Option<HashMap<String, (Rank, String)>>,
    shown: HashSet<String>,
    pending: HashMap<String, (Instant, (Rank, String))>,
}

impl Notifier {
    /// When the next quiet window ends, to update again then.
    pub fn deadline(&self) -> Option<Instant> {
        self.pending.values().map(|(at, _)| *at).min()
    }

    pub fn update(
        &mut self,
        rows: &[Row<'_>],
        in_view: &HashSet<String>,
        enabled: bool,
        now: Instant,
    ) -> Vec<Alert> {
        let starting = self.last.is_none();
        let previous = self.last.take().unwrap_or_default();
        let mut alerts = Vec::new();
        let mut current = HashMap::new();
        for row in rows {
            let key = (row.status.rank, row.status.line());
            let announces =
                row.status.rank.needs_you() || (row.status.rank == Rank::Done && row.status.unseen);
            let quiet = !announces || in_view.contains(row.id) || row.muted || !enabled;
            if quiet && self.shown.remove(row.id) {
                alerts.push(Alert::Withdraw {
                    chat_id: row.id.to_owned(),
                });
            }
            if self
                .pending
                .get(row.id)
                .is_some_and(|(_, waiting)| quiet || *waiting != key)
            {
                self.pending.remove(row.id);
            }
            if !quiet && !starting && previous.get(row.id) != Some(&key) {
                if row.status.rank == Rank::Done {
                    self.pending
                        .insert(row.id.to_owned(), (now + QUIET_WINDOW, key.clone()));
                } else {
                    alerts.push(show(row));
                    self.shown.insert(row.id.to_owned());
                }
            }
            if self.pending.get(row.id).is_some_and(|(at, _)| *at <= now) {
                self.pending.remove(row.id);
                alerts.push(show(row));
                self.shown.insert(row.id.to_owned());
            }
            current.insert(row.id.to_owned(), key);
        }
        // A Chat that left the rows (trashed) keeps nothing.
        self.pending.retain(|id, _| current.contains_key(id));
        for id in self
            .shown
            .iter()
            .filter(|id| !current.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>()
        {
            self.shown.remove(&id);
            alerts.push(Alert::Withdraw { chat_id: id });
        }
        self.last = Some(current);
        alerts
    }
}

fn show(row: &Row<'_>) -> Alert {
    Alert::Show {
        chat_id: row.id.to_owned(),
        title: row.title.to_owned(),
        body: row.status.line(),
    }
}

/// The app-icon count's text: Chats waiting for the person, "99+" above 99.
pub fn badge_text(count: usize) -> Option<String> {
    match count {
        0 => None,
        1..=99 => Some(count.to_string()),
        _ => Some("99+".to_owned()),
    }
}

#[cfg(test)]
#[path = "attention_tests.rs"]
mod tests;
