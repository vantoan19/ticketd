//! Which Chats need the person, which hold something they have not seen, and when the
//! system is told (spec 21.3). Every surface reads one ranked status per Chat: the list
//! row, the sidebar count, the app-icon count and system notifications.
//!
//! Nothing here touches Tauri; the desktop shows what `Notifier` decides.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::conditions::ChatProblemKind;
use crate::{ChatLive, InteractionKind, ProblemKind, TurnEnding};
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
    /// The word naming its rank, for a one-line summary such as a ticket's Chats line:
    /// `word`, except that Idle after a finished turn says "Done", not the reply.
    pub label: String,
    /// What it is about; truncated first.
    pub detail: Option<String>,
    /// What a notification says in place of `line()`, when that is something else: a
    /// sub-agent's approval says its card's title, which names it and what it would do.
    #[serde(skip)]
    announcement: Option<String>,
}

impl Status {
    /// What the system's notification says.
    pub fn notification(&self) -> String {
        self.announcement.clone().unwrap_or_else(|| self.line())
    }

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
    /// The first record the agent changed in the last turn.
    pub first_change: Option<&'a ChatAgentChange>,
    /// How many files the last turn changed.
    pub files_changed: Option<usize>,
    pub last_response: Option<&'a str>,
    /// How many sub-agents the person stopped while no turn ran, when that is the Chat's
    /// last event (no turn has started since).
    pub stopped_sub_agents: Option<i64>,
    /// Who asked each request a sub-agent asked, by its interaction ID. A request not
    /// listed is the main agent's.
    pub asking: &'a [Asking],
}

/// A request a sub-agent asked, as the Chat view words it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asking {
    pub interaction_id: String,
    /// The sub-agent's title.
    pub asker: String,
    /// The request card's title, naming the sub-agent: "Check limiter test coverage
    /// wants to run npm test".
    pub card: String,
}

/// What a turn's changes read as, in order: each ticket's status moves netted into one
/// (the first `from`, the last `to`, dropped when they are equal), standing where the
/// ticket's first move stood. The Chat view's records row says these sentences, and an
/// idle row's second line says the first of them. The desktop's view sends the net list
/// with each records item, so this is the one place the rule lives.
pub fn net_changes(changes: &[ChatAgentChange]) -> Vec<ChatAgentChange> {
    let mut net: Vec<ChatAgentChange> = Vec::new();
    for change in changes {
        if let ChatAgentChange::Status { reference, to, .. } = change
            && let Some(ChatAgentChange::Status { to: earlier, .. }) =
                net.iter_mut().find(|kept| {
                    matches!(kept, ChatAgentChange::Status { reference: kept, .. } if kept == reference)
                })
        {
            earlier.clone_from(to);
        } else {
            net.push(change.clone());
        }
    }
    net.retain(|change| !matches!(change, ChatAgentChange::Status { from, to, .. } if from == to));
    net
}

/// What the agent did to a record, verb first.
pub fn change_line(change: &ChatAgentChange) -> String {
    match change {
        ChatAgentChange::Status { reference, to, .. } => format!("Moved {reference} to {to}"),
        ChatAgentChange::Update { reference, .. } => format!("Posted an update on {reference}"),
    }
}

/// The first line of Markdown as plain text, whole.
fn plain_text(markdown: &str) -> Option<String> {
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
    (!text.is_empty()).then(|| text.to_owned())
}

/// The first line of Markdown as plain words, for a one-line detail.
fn plain_start(markdown: &str) -> Option<String> {
    plain_text(markdown).map(|text| text.chars().take(140).collect())
}

/// "1 file changed", "3 files changed".
fn files_line(count: usize) -> String {
    let noun = if count == 1 { "file" } else { "files" };
    format!("{count} {noun} changed")
}

/// Characters of a reply a row's second line keeps before it cuts at a word.
const FIRST_WORDS: usize = 60;

/// The first words of a reply, cut at a word with "…". A link is whole or left out:
/// a row never shows half of one.
fn first_words(markdown: &str) -> Option<String> {
    // Whole, so the word limit below is the only cut and never leaves half a word.
    let text = plain_text(markdown)?;
    let mut kept = String::new();
    let mut cut = false;
    for word in text.split_whitespace() {
        let link = word.starts_with("http://") || word.starts_with("https://");
        let next = if kept.is_empty() {
            word.chars().count()
        } else {
            kept.chars().count() + 1 + word.chars().count()
        };
        if link || next > FIRST_WORDS {
            cut = true;
            break;
        }
        if !kept.is_empty() {
            kept.push(' ');
        }
        kept.push_str(word);
    }
    // A cut after a lead-in such as "I opened the PR:" drops its colon.
    let kept = if cut {
        kept.trim_end_matches([':', ',', ';', '-']).to_owned()
    } else {
        kept
    };
    if kept.is_empty() {
        return None;
    }
    Some(if cut { format!("{kept}…") } else { kept })
}

/// Why a turn ended with an error, in a few words: what its notice is titled.
fn failure_detail(kind: ProblemKind, harness: &str) -> String {
    ChatProblemKind::from(kind).title(harness, true)
}

pub fn status(facts: &Facts<'_>) -> Status {
    let ended = facts
        .last_turn
        .filter(|turn| turn.state != ChatTurnState::Active);
    // Only an outcome the person has not seen ranks as Failed or Done; a Chat they
    // marked unread keeps the words it had, with the blue dot, and never notifies.
    let unseen = ended.is_some_and(|turn| facts.chat.unseen(turn));
    let labelled = |rank, word: &str, label: &str, detail: Option<String>| Status {
        rank,
        unseen: unseen || facts.chat.marked_unread,
        word: word.to_owned(),
        label: label.to_owned(),
        detail,
        announcement: None,
    };
    let make = |rank, word: &str, detail: Option<String>| labelled(rank, word, word, detail);
    let requests = &facts.live.interactions;
    let approval = requests.iter().find_map(|request| match &request.kind {
        InteractionKind::Approval { description, .. }
        | InteractionKind::NativeApproval { description, .. } => {
            Some((description, &request.interaction_id))
        }
        InteractionKind::Question { .. } => None,
    });
    if let Some((description, interaction)) = approval {
        // A sub-agent's approval names it: that is what the row and the notification say.
        if let Some(asking) = facts
            .asking
            .iter()
            .find(|asking| &asking.interaction_id == interaction)
        {
            return Status {
                announcement: Some(asking.card.clone()),
                ..make(Rank::Approval, "Approval needed", Some(asking.asker.clone()))
            };
        }
        // A ticketd call reads without ticketd's path or the variable naming it.
        let command = match crate::step_kind::ticketd_calls(description) {
            Some(calls) => calls
                .iter()
                .map(|args| crate::step_kind::ticketd_command(args))
                .collect::<Vec<_>>()
                .join("; "),
            None => crate::step_kind::shown_command(description),
        };
        return make(Rank::Approval, "Approval needed", plain_start(&command));
    }
    let question = requests.iter().find_map(|request| match &request.kind {
        InteractionKind::Question { questions } => {
            Some(questions.first().map(|question| question.prompt.as_str()))
        }
        InteractionKind::Approval { .. } | InteractionKind::NativeApproval { .. } => None,
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
        let detail = match facts.live.sub_agents {
            _ if facts.opening => Some("Starting".to_owned()),
            0 => None,
            1 => Some("1 sub-agent".to_owned()),
            count => Some(format!("{count} sub-agents")),
        };
        return make(Rank::Working, "Working", detail);
    }
    if facts.problem == Some((ChatProblemKind::Failed, false)) {
        return make(Rank::Failed, "Failed", facts.failure.map(str::to_owned));
    }
    if let Some(count) = facts.stopped_sub_agents.filter(|count| *count > 0) {
        let noun = if count == 1 {
            "sub-agent"
        } else {
            "sub-agents"
        };
        return make(Rank::Idle, &format!("You stopped {count} {noun}"), None);
    }
    // What the turn did, by what is worth most: a record it changed, the files it
    // changed, then the first words of its reply.
    let done = || {
        facts
            .first_change
            .map(change_line)
            .or_else(|| facts.files_changed.filter(|n| *n > 0).map(files_line))
            .or_else(|| facts.last_response.and_then(first_words))
    };
    let outcome = ended.and_then(TurnEnding::of).map(|ending| match ending {
        TurnEnding::Completed => (Rank::Done, "Done".to_owned(), done()),
        TurnEnding::Failed { kind, .. } => (
            Rank::Failed,
            "Failed".to_owned(),
            Some(failure_detail(kind, facts.harness)),
        ),
        // ticketd stopped it, whether or not the harness reported the turn. The cause is
        // the detail, so a narrow row shortens it and never the word.
        TurnEnding::StoppedByTicketd(reason) => (
            Rank::Idle,
            "Stopped".to_owned(),
            Some(reason.cause().to_owned()),
        ),
        TurnEnding::ContactLost(_) => (
            Rank::Failed,
            "Interrupted".to_owned(),
            Some(format!("{} stopped mid-turn", facts.harness)),
        ),
        TurnEnding::StoppedByPerson => (Rank::Idle, "You stopped it".to_owned(), None),
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
        Some((Rank::Done, word, Some(line))) => labelled(Rank::Idle, &line, &word, None),
        // A finished turn with nothing to say about it, and a Chat with no turn yet.
        Some((Rank::Done, _, None)) => make(Rank::Idle, "Done", None),
        None => make(Rank::Idle, "No messages yet", None),
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
        body: row.status.notification(),
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
