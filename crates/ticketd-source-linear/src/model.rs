use serde::Deserialize;
use ticketd_source_sdk::{
    ExternalComment, ExternalEvent, ExternalEventKind, ExternalIdentity, ExternalIssue,
    ExternalRef, ExternalState, StateCategory,
};
use uuid::Uuid;

use crate::api::Page;

pub(crate) const PROVIDER: &str = "linear";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Person {
    pub(crate) id: Uuid,
    pub(crate) display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersonName {
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActorBot {
    name: Option<String>,
    user_display_name: Option<String>,
}

fn actor_name(user: Option<PersonName>, bot: Option<ActorBot>) -> Option<String> {
    user.map(|user| user.display_name)
        .or_else(|| bot.and_then(|bot| bot.user_display_name.or(bot.name)))
}

#[derive(Deserialize)]
pub(crate) struct Named {
    pub(crate) id: Uuid,
    pub(crate) name: String,
}

#[derive(Deserialize)]
pub(crate) struct Team {
    pub(crate) id: Uuid,
    pub(crate) key: String,
    pub(crate) name: String,
}

#[derive(Deserialize)]
pub(crate) struct Id {
    pub(crate) id: Uuid,
}

#[derive(Deserialize)]
pub(crate) struct State {
    pub(crate) name: String,
    #[serde(rename = "type")]
    kind: String,
}

impl State {
    pub(crate) fn category(&self) -> StateCategory {
        use StateCategory::*;
        match self.kind.as_str() {
            "triage" | "backlog" | "unstarted" | "started" => Open,
            "completed" => Completed,
            "canceled" => NotPlanned,
            "duplicate" => Duplicate,
            _ => Unknown,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Issue {
    pub(crate) id: Uuid,
    pub(crate) identifier: String,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) description: Option<String>,
    pub(crate) created_at: String,
    updated_at: String,
    pub(crate) trashed: Option<bool>,
    pub(crate) team: Id,
    pub(crate) state: State,
    pub(crate) creator: Option<Person>,
    assignee: Option<PersonName>,
    pub(crate) labels: Option<Page<Named>>,
}

impl Issue {
    // The mutation receipt and search already carry an issue. Further reads can
    // fail after creation, while a later refresh can fill in remaining labels.
    pub(crate) fn into_publication_issue(mut self) -> ExternalIssue {
        let labels = self
            .labels
            .take()
            .into_iter()
            .flat_map(|page| page.nodes)
            .map(|label| label.name)
            .collect();
        self.into_external(labels, None)
    }

    pub(crate) fn into_external(
        self,
        labels: Vec<String>,
        duplicate: Option<RelatedIssue>,
    ) -> ExternalIssue {
        ExternalIssue {
            repository: None,
            reference: reference(self.id, self.identifier.clone(), self.team.id),
            display: self.identifier,
            url: self.url,
            title: self.title,
            body: self.description.unwrap_or_default(),
            state: ExternalState::named(self.state.category(), self.state.name),
            assignees: self
                .assignee
                .into_iter()
                .map(|user| user.display_name)
                .collect(),
            labels,
            created_at: self.created_at,
            updated_at: self.updated_at,
            author: self.creator.map(|user| user.display_name),
            duplicate_of: duplicate
                .as_ref()
                .map(|issue| reference(issue.id, issue.identifier.clone(), issue.team.id)),
            duplicate_of_url: duplicate.map(|issue| issue.url),
            duplicate_withdrawn: false,
        }
    }
}

fn reference(id: Uuid, locator: String, team: Uuid) -> ExternalRef {
    ExternalRef {
        identity: ExternalIdentity {
            provider: PROVIDER.into(),
            id: id.to_string(),
        },
        locator,
        partition: team.to_string(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Relation {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) issue: Id,
    pub(crate) related_issue: RelatedIssue,
}

#[derive(Deserialize)]
pub(crate) struct RelatedIssue {
    pub(crate) id: Uuid,
    identifier: String,
    url: String,
    team: Id,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Comment {
    id: Uuid,
    body: String,
    created_at: String,
    updated_at: String,
    url: String,
    user: Option<PersonName>,
    bot_actor: Option<ActorBot>,
}

impl From<Comment> for ExternalComment {
    fn from(comment: Comment) -> Self {
        Self {
            id: comment.id.to_string(),
            author: actor_name(comment.user, comment.bot_actor)
                .unwrap_or_else(|| "Unknown author".into()),
            body: comment.body,
            created_at: comment.created_at,
            updated_at: comment.updated_at,
            url: comment.url,
        }
    }
}

#[derive(Deserialize)]
struct RelationChange {
    #[serde(rename = "type")]
    kind: String,
    identifier: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct History {
    id: Uuid,
    created_at: String,
    actor: Option<PersonName>,
    bot_actor: Option<ActorBot>,
    from_state_id: Option<Uuid>,
    to_state_id: Option<Uuid>,
    from_state: Option<State>,
    to_state: Option<State>,
    from_assignee_id: Option<Uuid>,
    to_assignee_id: Option<Uuid>,
    from_assignee: Option<PersonName>,
    to_assignee: Option<PersonName>,
    relation_changes: Option<Vec<RelationChange>>,
}

impl History {
    pub(crate) fn into_events(self) -> Vec<ExternalEvent> {
        use ExternalEventKind::*;
        use StateCategory::*;

        let actor = actor_name(self.actor, self.bot_actor);
        let relation_changes = self.relation_changes.unwrap_or_default();
        let mut events = Vec::new();
        let mut push = |id: &str, kind, subject| {
            events.push(ExternalEvent {
                id: format!("{}:{id}", self.id),
                kind,
                actor: actor.clone(),
                subject,
                created_at: self.created_at.clone(),
            });
        };
        let mut duplicate_closure = None;
        if self.to_state_id.is_some() && self.to_state_id != self.from_state_id {
            let from = self.from_state.as_ref().map_or(Unknown, State::category);
            let to = self.to_state.as_ref().map_or(Unknown, State::category);
            let kind = match to {
                Completed | NotPlanned | Duplicate if to != from => Closed(to),
                Open if matches!(from, Completed | NotPlanned | Duplicate) => Reopened,
                _ => StateChanged(to),
            };
            if kind == Closed(Duplicate) {
                duplicate_closure = relation_changes
                    .iter()
                    .find(|change| change.kind == "ad")
                    .map(|change| change.identifier.as_str());
            }
            let subject = match kind {
                Closed(Duplicate) => duplicate_closure.map(str::to_owned),
                StateChanged(_) => self.to_state.map(|state| state.name),
                _ => None,
            };
            push("state", kind, subject);
        }
        if self.from_assignee_id != self.to_assignee_id {
            let name = |user: Option<PersonName>| {
                Some(user.map_or_else(|| "an unavailable account".into(), |user| user.display_name))
            };
            if self.from_assignee_id.is_some() {
                push("unassigned", Unassigned, name(self.from_assignee));
            }
            if self.to_assignee_id.is_some() {
                push("assigned", Assigned, name(self.to_assignee));
            }
        }
        let mut seen = std::collections::HashSet::new();
        for change in &relation_changes {
            let kind = match change.kind.as_str() {
                "ad" if duplicate_closure != Some(change.identifier.as_str()) => MarkedDuplicate,
                "rd" => UnmarkedDuplicate,
                "am" => DuplicateAdded,
                "rm" => DuplicateRemoved,
                _ => continue,
            };
            if seen.insert((change.kind.as_str(), change.identifier.as_str())) {
                push(
                    &format!("{}:{}", change.kind, change.identifier),
                    kind,
                    Some(change.identifier.clone()),
                );
            }
        }
        events
    }
}
