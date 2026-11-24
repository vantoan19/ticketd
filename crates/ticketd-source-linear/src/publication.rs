use std::collections::HashSet;

use chrono::DateTime;
use serde::Deserialize;
use serde_json::json;
use ticketd_source_sdk::{
    ErrorCode, ExtensionError, ExternalIssue, FieldIssue, PublicationCandidates, PublicationSearch,
    PublishRequest,
};
use url::Url;
use uuid::Uuid;

use crate::{
    api::{Graphql, PAGE_SIZE, Page},
    model::{Issue, Team},
};

const SEARCH_PAGES: usize = 20;

#[derive(Deserialize)]
struct MutationReceipt {
    success: bool,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    issue: Option<Issue>,
}

pub(crate) fn publish(
    api: &Graphql<'_>,
    teams: &[Uuid],
    request: &PublishRequest,
) -> Result<ExternalIssue, ExtensionError> {
    let team = destination(&request.destination)
        .ok()
        .filter(|team| teams.contains(team))
        .ok_or_else(|| {
            ExtensionError::new(
                ErrorCode::NotSent,
                "choose one of the teams saved for this Linear connection",
            )
        })?;
    let receipt: MutationReceipt = api.create_issue(json!({
        "teamId": team,
        "title": request.title,
        "description": request.body,
    }))?;
    if !receipt.success && receipt.issue.is_none() {
        return Err(ExtensionError::new(
            ErrorCode::Rejected,
            "Linear refused to create the issue",
        ));
    }
    let issue = receipt
        .issue
        .filter(|issue| receipt.success && issue.team.id == team)
        .ok_or_else(|| protocol("Linear did not confirm creation in the chosen team"))?;
    validate_identity(&issue)?;
    Ok(issue.into_publication_issue())
}

pub(crate) fn locate(
    api: &Graphql<'_>,
    destination_text: &str,
    text: &str,
) -> Result<Issue, ExtensionError> {
    let team = destination(destination_text)?;
    let text = text.trim();
    let supplied_url = Url::parse(text).ok();
    let (workspace, text) = if let Some(url) = &supplied_url {
        let (workspace, id) = url_issue(url).ok_or_else(invalid_issue)?;
        (Some(workspace), id)
    } else {
        (None, text)
    };
    let uuid = Uuid::parse_str(text).ok();
    let lookup = if let Some(uuid) = uuid {
        uuid.to_string()
    } else if let Some((key, number)) = text.rsplit_once('-') {
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || !issue_number(number)
        {
            return Err(invalid_issue());
        }
        text.to_ascii_uppercase()
    } else {
        let number = text.strip_prefix('#').unwrap_or(text);
        if workspace.is_some() || !issue_number(number) {
            return Err(invalid_issue());
        }
        let team = destination_team(api, team)?;
        format!("{}-{number}", team.key)
    };
    let issue: Issue = api.request("LinearLocate", json!({"id": lookup}), &["issue"])?;
    validate_identity(&issue)?;
    if uuid.is_some_and(|id| issue.id != id) {
        return Err(protocol("Linear returned a different issue"));
    }
    if issue.team.id != team {
        return Err(ExtensionError::configuration(vec![FieldIssue::for_form(
            "belongs to a different Linear team",
        )]));
    }
    if let Some(workspace) = workspace
        && Url::parse(&issue.url)
            .ok()
            .as_ref()
            .and_then(url_issue)
            .is_none_or(|(slug, _)| slug != workspace)
    {
        return Err(ExtensionError::configuration(vec![FieldIssue::for_form(
            "link points to a different Linear workspace",
        )]));
    }
    Ok(issue)
}

pub(crate) fn find_published(
    api: &Graphql<'_>,
    search: &PublicationSearch,
) -> Result<PublicationCandidates, ExtensionError> {
    let team = destination(&search.request.destination)?;
    // Device time cannot bound the tracker listing. Older attempts or missing
    // Date headers can still return candidates, but cannot prove absence.
    let since = search
        .tracker_since
        .as_deref()
        .and_then(|time| DateTime::parse_from_rfc3339(time).ok());
    let mut filter = json!({"team": {"id": {"eq": team}}});
    if let Some(since) = since {
        filter["createdAt"] = json!({"gte": since.to_rfc3339()});
    }
    // A filtered list may be empty if the key lost access to the original team.
    destination_team(api, team)?;
    let account = search
        .account
        .as_deref()
        .and_then(|id| Uuid::parse_str(id).ok());
    let title = normalized_text(&search.request.title);
    let body = normalized_text(&search.request.body);
    let mut found = PublicationCandidates {
        matches: Vec::new(),
        recent: Vec::new(),
        complete: false,
    };
    let mut seen_issues = HashSet::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor = None;
    for _ in 0..SEARCH_PAGES {
        let page: Page<Issue> = api.request(
            "LinearPublicationSearch",
            json!({"filter": filter, "first": PAGE_SIZE, "after": cursor}),
            &["issues"],
        )?;
        let next = page.next_cursor();
        for issue in page.nodes {
            validate_identity(&issue)?;
            if issue.team.id != team {
                return Err(protocol(
                    "Linear returned an issue from outside the publication team",
                ));
            }
            let created_at = DateTime::parse_from_rfc3339(&issue.created_at)
                .map_err(|_| protocol("Linear returned an invalid issue creation time"))?;
            if since.is_some_and(|since| created_at < since) || !seen_issues.insert(issue.id) {
                continue;
            }
            if normalized_text(&issue.title) == title
                || (!body.is_empty()
                    && normalized_text(issue.description.as_deref().unwrap_or_default()) == body)
            {
                found.matches.push(issue.into_publication_issue());
            } else if account.is_some_and(|id| {
                issue
                    .creator
                    .as_ref()
                    .is_some_and(|creator| creator.id == id)
            }) {
                found.recent.push(issue.into_publication_issue());
            }
        }
        match next {
            // An issue can move to another team after creation. Exhausting
            // the original team's current issues cannot establish absence.
            Ok(None) => break,
            Ok(Some(next)) if seen_cursors.insert(next.clone()) => cursor = Some(next),
            _ => break,
        }
    }
    Ok(found)
}

fn issue_number(text: &str) -> bool {
    text.parse::<u64>().is_ok_and(|number| number > 0)
        && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn url_issue(url: &Url) -> Option<(&str, &str)> {
    if url.scheme() != "https"
        || url.host_str() != Some("linear.app")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let mut parts = url.path_segments()?;
    let workspace = parts.next().filter(|part| !part.is_empty())?;
    if parts.next() != Some("issue") {
        return None;
    }
    Some((workspace, parts.next().filter(|part| !part.is_empty())?))
}

fn destination(text: &str) -> Result<Uuid, ExtensionError> {
    Uuid::parse_str(text)
        .ok()
        .filter(|id| !id.is_nil())
        .ok_or_else(|| {
            ExtensionError::configuration(vec![FieldIssue::for_field(
                "destination",
                "choose a Linear team",
            )])
        })
}

fn destination_team(api: &Graphql<'_>, team: Uuid) -> Result<Team, ExtensionError> {
    let found: Team = api.request("LinearDestinationTeam", json!({"team": team}), &["team"])?;
    if found.id != team {
        return Err(protocol("Linear returned a different destination team"));
    }
    Ok(found)
}

fn validate_identity(issue: &Issue) -> Result<(), ExtensionError> {
    if issue.trashed == Some(true) {
        return Err(protocol("Linear returned a trashed issue"));
    }
    if issue.id.is_nil()
        || issue.identifier.trim().is_empty()
        || Url::parse(&issue.url)
            .ok()
            .as_ref()
            .and_then(url_issue)
            .is_none()
    {
        return Err(protocol(
            "Linear returned an issue without a usable identity",
        ));
    }
    Ok(())
}

fn invalid_issue() -> ExtensionError {
    ExtensionError::configuration(vec![FieldIssue::for_form(
        "must be a Linear issue reference, number, or link",
    )])
}

fn normalized_text(text: &str) -> String {
    text.replace("\r\n", "\n").trim().to_owned()
}

fn protocol(message: &str) -> ExtensionError {
    ExtensionError::new(ErrorCode::Protocol, message)
}
