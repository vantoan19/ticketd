use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Value, json};
use ticketd_source_sdk::{
    ChoiceOption, ConfigValues, ConnectionCheck, ConnectionInfo, Conversation,
    DerivedConfiguration, DiscoveryPage, DiscoveryRequest, ErrorCode, Extension, ExtensionError,
    ExternalIssue, ExternalRef, FieldIssue, RequestContext, SourceDescription, StateCategory,
};
use uuid::Uuid;

use crate::{
    api::{Client, Graphql, Page},
    model::{Comment, History, Id, Issue, Named, PROVIDER, Person, RelatedIssue, Relation, Team},
};

pub(crate) struct Linear {
    description: SourceDescription,
    client: Client,
}

impl Linear {
    pub(crate) fn new(description: SourceDescription) -> Result<Self, ExtensionError> {
        Ok(Self {
            description,
            client: Client::new()?,
        })
    }

    fn api<'a>(
        &'a self,
        context: &'a RequestContext<'a>,
        config: &ConfigValues,
    ) -> Result<Graphql<'a>, ExtensionError> {
        let key = config
            .get("api_key")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .ok_or_else(|| {
                ExtensionError::new(
                    ErrorCode::Unauthenticated,
                    "a Linear personal API key is required",
                )
            })?;
        self.client.with_key(context, key)
    }
}

impl Extension for Linear {
    fn description(&self) -> SourceDescription {
        self.description.clone()
    }

    fn validate(
        &self,
        _context: &RequestContext<'_>,
        config: &ConfigValues,
    ) -> Result<Vec<FieldIssue>, ExtensionError> {
        Ok(self
            .description
            .descriptor
            .schema
            .validate(config)
            .err()
            .unwrap_or_default())
    }

    fn check_connection(
        &self,
        context: &RequestContext<'_>,
        config: &ConfigValues,
    ) -> Result<ConnectionCheck, ExtensionError> {
        let teams = required_teams(config)?;
        let api = self.api(context, config)?;
        let connection: LinearConnection = api.request("LinearConnection", json!({}), &[])?;
        let visible: HashSet<_> = api
            .all::<Id>(
                "LinearConfiguredTeams",
                json!({"teams": teams}),
                &["teams"],
                None,
            )?
            .into_iter()
            .map(|team| team.id)
            .collect();
        if teams.iter().any(|team| !visible.contains(team)) {
            return Err(ExtensionError::configuration(vec![FieldIssue::for_field(
                "team",
                "choose teams this Linear API key can read",
            )]));
        }
        let filters = Filters::read(config);
        let scope =
            if filters.assignee.is_none() && filters.labels.is_empty() && filters.project.is_none()
            {
                String::new()
            } else {
                json!([filters.assignee, filters.labels, filters.project]).to_string()
            };
        Ok(ConnectionCheck {
            connection: ConnectionInfo {
                account: connection.viewer.display_name,
                account_id: Some(connection.viewer.id.to_string()),
                site: connection.organization.id.to_string(),
            },
            derived: DerivedConfiguration {
                partitions: teams.iter().map(Uuid::to_string).collect(),
                discovery_scope: scope,
                ..DerivedConfiguration::default()
            },
        })
    }

    fn options(
        &self,
        context: &RequestContext<'_>,
        config: &ConfigValues,
        field: &str,
        query: &str,
    ) -> Result<Vec<ChoiceOption>, ExtensionError> {
        let api = self.api(context, config)?;
        let choices = if field == "team" {
            api.all::<Team>("LinearTeams", json!({}), &["teams"], None)?
                .into_iter()
                .map(|team| choice(team.id.to_string(), team.name, Some(team.key)))
                .collect()
        } else {
            let teams = selected_teams(config);
            if teams.is_empty() {
                return Ok(Vec::new());
            }
            match field {
                "labels" => names(api.all(
                    "LinearLabels",
                    json!({"teams": teams}),
                    &["issueLabels"],
                    None,
                )?),
                "project" | "assignee" => team_choices(&api, &teams, field)?,
                _ => {
                    return Err(ExtensionError::configuration(vec![FieldIssue::for_form(
                        "the Linear setting has no options",
                    )]));
                }
            }
        };
        let query = query.trim().to_lowercase();
        Ok(choices
            .into_iter()
            .filter(|option| {
                option.label.to_lowercase().contains(&query)
                    || option
                        .description
                        .as_ref()
                        .is_some_and(|description| description.to_lowercase().contains(&query))
                    || option.value.to_lowercase().contains(&query)
            })
            .collect())
    }

    fn discover(
        &self,
        context: &RequestContext<'_>,
        request: DiscoveryRequest<'_>,
    ) -> Result<DiscoveryPage, ExtensionError> {
        let teams = required_teams(request.config)?;
        let api = self.api(context, request.config)?;
        context.progress(0, None)?;
        let filters = Filters::read(request.config);
        let filter = filters.graphql(&api, &teams)?;
        let page: Page<Issue> = api.request(
            "LinearDiscover",
            json!({"filter": filter, "first": request.page_size.clamp(1, 250), "after": request.cursor}),
            &["issues"],
        )?;
        let next_cursor = page.next_cursor()?;
        if page
            .nodes
            .iter()
            .any(|issue| !teams.contains(&issue.team.id))
        {
            return Err(protocol("Linear returned an issue from an unselected team"));
        }
        let issues = page
            .nodes
            .into_iter()
            .filter(|issue| issue.trashed != Some(true))
            .map(|issue| external_issue(&api, issue))
            .collect::<Result<_, _>>()?;
        Ok(DiscoveryPage {
            issues,
            next_cursor,
            skipped: Vec::new(),
        })
    }

    fn fetch(
        &self,
        context: &RequestContext<'_>,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, ExtensionError> {
        let id = issue_id(reference)?;
        let api = self.api(context, config)?;
        let issue: Issue = api.request("LinearFetch", json!({"id": id}), &["issue"])?;
        if issue.id != id {
            return Err(protocol("Linear returned a different issue"));
        }
        if issue.trashed == Some(true) {
            return Err(ExtensionError::new(
                ErrorCode::NotFound,
                "the Linear issue is in the trash",
            ));
        }
        external_issue(&api, issue)
    }

    fn conversation(
        &self,
        context: &RequestContext<'_>,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<Conversation, ExtensionError> {
        let id = issue_id(reference)?;
        let api = self.api(context, config)?;
        let comments: Vec<Comment> = api.all(
            "LinearComments",
            json!({"id": id}),
            &["issue", "comments"],
            None,
        )?;
        let history: Vec<History> = api.all(
            "LinearHistory",
            json!({"id": id}),
            &["issue", "history"],
            None,
        )?;
        Ok(Conversation {
            comments: comments.into_iter().map(Into::into).collect(),
            events: history.into_iter().flat_map(History::into_events).collect(),
        })
    }
}

#[derive(Deserialize)]
struct LinearConnection {
    viewer: Person,
    organization: Id,
}

#[derive(Default)]
struct Filters<'a> {
    assignee: Option<&'a str>,
    labels: Vec<Uuid>,
    project: Option<Uuid>,
}

impl<'a> Filters<'a> {
    fn read(config: &'a ConfigValues) -> Self {
        let mut labels: Vec<_> = values(config, "labels").filter_map(parse_uuid).collect();
        labels.sort_unstable();
        labels.dedup();
        Self {
            assignee: values(config, "assignee").next(),
            labels,
            project: values(config, "project").next().and_then(parse_uuid),
        }
    }

    fn graphql(&self, api: &Graphql<'_>, teams: &[Uuid]) -> Result<Value, ExtensionError> {
        let mut filter = json!({"team": {"id": {"in": teams}}});
        if let Some(assignee) = self.assignee {
            let id = if assignee == "me" {
                api.request::<Id>("LinearMe", json!({}), &["viewer"])?.id
            } else {
                parse_uuid(assignee).ok_or_else(|| invalid_uuid("assignee"))?
            };
            filter["assignee"] = json!({"id": {"eq": id}});
        }
        if !self.labels.is_empty() {
            filter["and"] = Value::Array(
                self.labels
                    .iter()
                    .map(|label| json!({"labels": {"some": {"id": {"eq": label}}}}))
                    .collect(),
            );
        }
        if let Some(project) = self.project {
            filter["project"] = json!({"id": {"eq": project}});
        }
        Ok(filter)
    }
}

fn choice(value: String, label: String, description: Option<String>) -> ChoiceOption {
    ChoiceOption {
        value,
        label,
        description,
    }
}

fn names(entries: Vec<Named>) -> Vec<ChoiceOption> {
    entries
        .into_iter()
        .map(|entry| choice(entry.id.to_string(), entry.name, None))
        .collect()
}

fn values<'a>(config: &'a ConfigValues, field: &str) -> impl Iterator<Item = &'a str> {
    config
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

fn parse_uuid(value: &str) -> Option<Uuid> {
    Uuid::parse_str(value).ok()
}

fn selected_teams(config: &ConfigValues) -> Vec<Uuid> {
    let mut teams: Vec<_> = values(config, "team").filter_map(parse_uuid).collect();
    teams.sort_unstable();
    teams.dedup();
    teams
}

fn required_teams(config: &ConfigValues) -> Result<Vec<Uuid>, ExtensionError> {
    let teams = selected_teams(config);
    if teams.is_empty() {
        return Err(invalid_uuid("team"));
    }
    Ok(teams)
}

fn team_choices(
    api: &Graphql<'_>,
    teams: &[Uuid],
    field: &str,
) -> Result<Vec<ChoiceOption>, ExtensionError> {
    let assignees = field == "assignee";
    let mut choices = Vec::new();
    if assignees {
        choices.push(choice(
            "me".into(),
            "Me".into(),
            Some("Connected Linear account".into()),
        ));
    }
    for team in teams {
        let variables = json!({"team": team});
        if assignees {
            choices.extend(
                api.all::<Person>("LinearAssignees", variables, &["team", "members"], None)?
                    .into_iter()
                    .map(|person| choice(person.id.to_string(), person.display_name, None)),
            );
        } else {
            choices.extend(names(api.all(
                "LinearProjects",
                variables,
                &["team", "projects"],
                None,
            )?));
        }
    }
    let mut seen = HashSet::new();
    choices.retain(|choice| seen.insert(choice.value.clone()));
    Ok(choices)
}

fn invalid_uuid(field: &str) -> ExtensionError {
    ExtensionError::configuration(vec![FieldIssue::for_field(field, "choose a Linear record")])
}

fn issue_id(reference: &ExternalRef) -> Result<Uuid, ExtensionError> {
    if reference.identity.provider != PROVIDER {
        return Err(protocol(
            "the issue reference belongs to a different provider",
        ));
    }
    parse_uuid(&reference.identity.id)
        .ok_or_else(|| protocol("the issue reference is missing its Linear UUID"))
}

fn external_issue(api: &Graphql<'_>, mut issue: Issue) -> Result<ExternalIssue, ExtensionError> {
    let id = issue.id;
    let labels = api
        .all::<Named>(
            "LinearIssueLabels",
            json!({"id": id}),
            &["issue", "labels"],
            issue.labels.take(),
        )?
        .into_iter()
        .map(|label| label.name)
        .collect();
    let duplicate = if issue.state.category() == StateCategory::Duplicate {
        canonical_issue(api, id)?
    } else {
        None
    };
    Ok(issue.into_external(labels, duplicate))
}

fn canonical_issue(api: &Graphql<'_>, id: Uuid) -> Result<Option<RelatedIssue>, ExtensionError> {
    let relations: Vec<Relation> = match api.all(
        "LinearRelations",
        json!({"id": id}),
        &["issue", "relations"],
        None,
    ) {
        Ok(relations) => relations,
        // No accessible target is weaker evidence than withdrawing a duplicate.
        Err(error) if matches!(error.code(), ErrorCode::NotFound | ErrorCode::Forbidden) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    Ok(relations
        .into_iter()
        .find(|relation| {
            relation.kind == "duplicate"
                && relation.issue.id == id
                && relation.related_issue.id != id
        })
        .map(|relation| relation.related_issue))
}

fn protocol(message: &str) -> ExtensionError {
    ExtensionError::new(ErrorCode::Protocol, message)
}
