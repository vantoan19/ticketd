//! The agents at work on a ticket, for the ticket's label "{model} is working on this
//! ticket" (spec #609, decisions 16 and 17; `docs/architecture.md`).
//!
//! Who counts: the main agent of a Chat linked to the ticket while its turn runs (waiting
//! for its sub-agents or for the person is still running), and any agent, main or
//! sub-agent, with a credited write on the ticket while it runs, even from a Chat the
//! ticket is not linked to. Finished, stopped and lost sub-agents never count, nor does a
//! Chat at rest. Credit is device-local, so on another computer the label has only the
//! linked Chats.
//!
//! The list is sent in the order the label reads it: an agent waiting for approval first,
//! then Chat by Chat (the most recently active first), each Chat's main agent before its
//! sub-agents, the oldest start first.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use serde::Serialize;
use ticketd_chat_host::{Activity, ChatLive};
use ticketd_core::{
    Chat, ChatInteractionKind, ChatInteractionState, ChatItem, ChatLinkKind, ChatOwner,
    ChatSubAgent, ChatSubAgentState, ChatToolState, Workspace,
};

use crate::chat_view::{
    Item, Summary, Tracker, harness_name, items, main_agent_model, retention, running_words,
    sub_agent_model,
};
use crate::chats::{Outcome, SUMMARY_ITEMS};

/// A request waiting for the person, as the label words it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApprovalView {
    /// The command (or subject) it asks to run.
    pub summary: String,
}

/// One agent at work on a ticket. The field meanings are in the run contract
/// (`TicketAgent` in `ticket-agents.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TicketAgentView {
    /// The Chat's id, or `{chat id}:{sub-agent id}`.
    pub id: String,
    pub chat_id: String,
    pub retention: &'static str,
    pub chat_title: String,
    /// The sub-agent's ID in its Chat; absent for the main agent.
    pub sub_agent: Option<String>,
    pub harness_id: String,
    pub harness_name: String,
    /// As the harness names it; absent when it said none.
    pub model: Option<String>,
    /// A sub-agent's title, or the Chat's title for the main agent.
    pub title: String,
    pub started_at: String,
    /// The main agent's current step in words.
    pub doing: Option<String>,
    pub approval: Option<ApprovalView>,
}

/// What one Chat says, read once for however many tickets ask.
struct Facts {
    chat: Chat,
    live: ChatLive,
    summary: Summary,
    sub_agents: Vec<ChatSubAgent>,
    items: Vec<ChatItem>,
    /// The pending approvals a person can answer, by the sub-agent that asked (`None`:
    /// the main agent).
    approvals: HashMap<Option<String>, String>,
}

impl Facts {
    fn main_runs(&self) -> bool {
        self.chat.active_turn.is_some() && self.live.activity != Activity::Idle
    }

    fn running_sub_agents(&self) -> usize {
        self.sub_agents
            .iter()
            .filter(|record| {
                record
                    .latest()
                    .is_some_and(|run| run.state == ChatSubAgentState::Running)
            })
            .count()
    }

    fn view(&self, sub_agent: Option<&ChatSubAgent>) -> Option<TicketAgentView> {
        let chat = &self.chat;
        let (started_at, model, title, doing) = match sub_agent {
            None => (
                chat.active_turn.as_ref()?.started_at.clone(),
                main_agent_model(&self.live),
                self.summary.title.clone(),
                self.doing(),
            ),
            Some(record) => {
                let run = record
                    .latest()
                    .filter(|run| run.state == ChatSubAgentState::Running)?;
                (
                    run.started_at.clone(),
                    sub_agent_model(record, &self.live),
                    record.title(),
                    None,
                )
            }
        };
        let native = sub_agent.map(|record| record.native_id.clone());
        Some(TicketAgentView {
            id: match &native {
                Some(native) => format!("{}:{native}", chat.id),
                None => chat.id.clone(),
            },
            chat_id: chat.id.clone(),
            retention: retention(chat),
            chat_title: self.summary.title.clone(),
            harness_id: chat.harness.clone(),
            harness_name: harness_name(&chat.harness).to_owned(),
            approval: self.approvals.get(&native).map(|summary| ApprovalView {
                summary: summary.clone(),
            }),
            sub_agent: native,
            model,
            title,
            started_at,
            doing,
        })
    }

    /// What the main agent does now: its running Step, else that it waits for its
    /// sub-agents.
    fn doing(&self) -> Option<String> {
        let turn = self.chat.active_turn.as_ref()?;
        let step = self.items.iter().rev().find_map(|item| match item {
            ChatItem::Tool(tool)
                if tool.state == ChatToolState::Running
                    && tool.owner == ChatOwner::Main
                    && tool.turn_id.as_deref() == Some(turn.id.as_str()) =>
            {
                running_words(tool, &self.chat)
            }
            _ => None,
        });
        step.or_else(|| match self.running_sub_agents() {
            0 => None,
            1 => Some("Waiting for 1 sub-agent".to_owned()),
            count => Some(format!("Waiting for {count} sub-agents")),
        })
    }
}

type Summarize<'a> = dyn Fn(&Chat, &ChatLive) -> Outcome<Summary> + 'a;

/// Reads the agents of tickets from the Chats on this computer.
pub struct Reader<'a> {
    workspace: &'a Workspace,
    /// The Chats outside the trash.
    chats: &'a [Chat],
    live: &'a HashMap<String, ChatLive>,
    summarize: &'a Summarize<'a>,
    facts: HashMap<String, Rc<Facts>>,
}

impl<'a> Reader<'a> {
    pub fn new(
        workspace: &'a Workspace,
        chats: &'a [Chat],
        live: &'a HashMap<String, ChatLive>,
        summarize: &'a Summarize<'a>,
    ) -> Self {
        Self {
            workspace,
            chats,
            live,
            summarize,
            facts: HashMap::new(),
        }
    }

    fn facts(&mut self, chat: &Chat) -> Outcome<Rc<Facts>> {
        if let Some(facts) = self.facts.get(&chat.id) {
            return Ok(facts.clone());
        }
        let live = self
            .live
            .get(&chat.id)
            .cloned()
            .unwrap_or_else(ChatLive::idle);
        let snapshot = self.workspace.chat_snapshot(&chat.id, SUMMARY_ITEMS)?;
        let tracker = Tracker::from_snapshot(&snapshot.items, &snapshot.sub_agents);
        let facts = Rc::new(Facts {
            approvals: approvals(&snapshot.chat, &live, &snapshot.items, &tracker),
            summary: (self.summarize)(chat, &live)?,
            sub_agents: snapshot.sub_agents,
            items: snapshot.items,
            chat: snapshot.chat,
            live,
        });
        self.facts.insert(chat.id.clone(), facts.clone());
        Ok(facts)
    }

    /// The agents at work on one ticket, in display order.
    pub fn agents(&mut self, ticket_id: &str, reference: &str) -> Outcome<Vec<TicketAgentView>> {
        let mut wanted: Vec<(String, Option<String>)> = self
            .chats
            .iter()
            .filter(|chat| {
                chat.links
                    .iter()
                    .any(|link| link.kind == ChatLinkKind::Ticket && link.id == ticket_id)
            })
            .map(|chat| (chat.id.clone(), None))
            .collect();
        for agent in self.workspace.ticket_writing_agents(reference)? {
            wanted.push((agent.chat_id, agent.sub_agent));
        }
        wanted.sort();
        wanted.dedup();
        let mut rows = Vec::new();
        for (chat_id, native) in wanted {
            let Some(chat) = self.chats.iter().find(|chat| chat.id == chat_id) else {
                continue;
            };
            let facts = self.facts(chat)?;
            let view = match &native {
                None => facts.main_runs().then(|| facts.view(None)).flatten(),
                Some(native) => facts
                    .sub_agents
                    .iter()
                    .find(|record| &record.native_id == native)
                    .and_then(|record| facts.view(Some(record))),
            };
            if let Some(view) = view {
                rows.push((view, facts.summary.updated_at.clone()));
            }
        }
        order(&mut rows);
        Ok(rows.into_iter().map(|(view, _)| view).collect())
    }

    /// Every ticket that has agents at work now, with them: what a change of the label
    /// anywhere is read from.
    pub fn all(&mut self) -> Outcome<Vec<(String, Vec<TicketAgentView>)>> {
        let mut tickets: BTreeMap<String, String> = BTreeMap::new();
        for chat in self.chats.iter().filter(|chat| chat.active_turn.is_some()) {
            for link in &chat.links {
                if link.kind != ChatLinkKind::Ticket {
                    continue;
                }
                if let Some(reference) = self.workspace.ticket_reference_of(&link.id)? {
                    tickets.insert(link.id.clone(), reference);
                }
            }
        }
        for (id, reference) in self.workspace.tickets_with_running_writers()? {
            tickets.insert(id, reference);
        }
        let mut all = Vec::new();
        for (id, reference) in tickets {
            let agents = self.agents(&id, &reference)?;
            if !agents.is_empty() {
                all.push((id, agents));
            }
        }
        Ok(all)
    }
}

/// The label's order: approval first, then the most recently active Chat first, its main
/// agent before its sub-agents, the oldest start first. Each row carries its Chat's latest
/// activity.
pub fn order(rows: &mut [(TicketAgentView, String)]) {
    rows.sort_by(|(a, a_active), (b, b_active)| -> Ordering {
        a.approval
            .is_none()
            .cmp(&b.approval.is_none())
            .then_with(|| b_active.cmp(a_active))
            .then_with(|| a.chat_id.cmp(&b.chat_id))
            .then_with(|| a.sub_agent.is_some().cmp(&b.sub_agent.is_some()))
            .then_with(|| a.started_at.cmp(&b.started_at))
    });
}

/// The approvals waiting for the person in a Chat, by the agent that asked, each as the
/// command or subject it asks to run. Only a request the host still holds can be answered.
fn approvals(
    chat: &Chat,
    live: &ChatLive,
    records: &[ChatItem],
    tracker: &Tracker,
) -> HashMap<Option<String>, String> {
    let mut found = HashMap::new();
    for record in records {
        let ChatItem::Interaction(interaction) = record else {
            continue;
        };
        if interaction.kind != ChatInteractionKind::Approval
            || interaction.state != ChatInteractionState::Pending
            || !live
                .interactions
                .iter()
                .any(|asked| asked.interaction_id == interaction.id)
        {
            continue;
        }
        let summary = items(record, chat, live, None, tracker)
            .into_iter()
            .find_map(|item| match item {
                Item::Request {
                    state: "pending",
                    command,
                    subject,
                    ..
                } => Some(
                    command
                        .or(subject)
                        .unwrap_or_else(|| "a command".to_owned()),
                ),
                _ => None,
            });
        let owner = match &interaction.owner {
            ChatOwner::Main => None,
            ChatOwner::SubAgent { native_id } => Some(native_id.clone()),
        };
        found.entry(owner).or_insert_with(|| {
            let summary = summary.unwrap_or_else(|| "a command".to_owned());
            crate::chat_view::cut_at_word(&summary, 120)
        });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use ticketd_chat_host::{ApprovalDecision, InteractionKind, LiveInteraction};
    use ticketd_core::{ChatInteraction, ChatTurn, ChatTurnState};

    fn chat() -> Chat {
        Chat {
            id: "c-limiter".to_owned(),
            title: None,
            harness: "claude-code".to_owned(),
            execution_folder: "/work/limiter".to_owned(),
            folder_managed: false,
            archived: false,
            trashed: false,
            queue_paused: false,
            effective_settings: None,
            native_session_id: None,
            links: Vec::new(),
            active_turn: Some(ChatTurn {
                id: "turn".to_owned(),
                position: 0,
                native_turn_id: None,
                state: ChatTurnState::Active,
                detail: None,
                problem: None,
                problem_resets_at: None,
                ending: None,
                origin: None,
                started_at: String::new(),
                ended_at: None,
            }),
            seen_through: 0,
            read_through: None,
            marked_unread: false,
            muted: false,
            restart_notice: Vec::new(),
            created_at: String::new(),
        }
    }

    fn ask(id: &str, owner: ChatOwner, state: ChatInteractionState) -> ChatItem {
        ChatItem::Interaction(ChatInteraction {
            id: id.to_owned(),
            position: 1,
            turn_id: None,
            owner,
            kind: ChatInteractionKind::Approval,
            native_request_id: None,
            prompt: "npm test -- rate-limit".to_owned(),
            reason: None,
            state,
            response: None,
            tool_id: None,
            asked_at: None,
            resolved_at: None,
        })
    }

    fn live_asking(ids: &[&str]) -> ChatLive {
        let mut live = ChatLive::idle();
        for id in ids {
            live.interactions.push(LiveInteraction {
                interaction_id: (*id).to_owned(),
                kind: InteractionKind::approval(
                    None,
                    None,
                    "npm test -- rate-limit",
                    vec![ApprovalDecision::Allow, ApprovalDecision::Deny],
                ),
            });
        }
        live
    }

    #[test]
    fn a_waiting_request_belongs_to_the_agent_that_asked() {
        let sub = ChatOwner::SubAgent {
            native_id: "sa-tests".to_owned(),
        };
        let records = vec![
            ask("asked-by-sub", sub, ChatInteractionState::Pending),
            ask("answered", ChatOwner::Main, ChatInteractionState::Answered),
        ];
        let live = live_asking(&["asked-by-sub"]);
        let tracker = Tracker::from_items(&records);

        let found = approvals(&chat(), &live, &records, &tracker);

        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(
            found.get(&Some("sa-tests".to_owned())).map(String::as_str),
            Some("npm test -- rate-limit")
        );
    }

    #[test]
    fn a_request_the_host_no_longer_holds_cannot_be_answered_so_is_not_waiting() {
        let records = vec![ask("gone", ChatOwner::Main, ChatInteractionState::Pending)];
        let tracker = Tracker::from_items(&records);

        assert!(approvals(&chat(), &ChatLive::idle(), &records, &tracker).is_empty());
    }
}
