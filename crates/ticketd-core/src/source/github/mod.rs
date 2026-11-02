//! The built-in GitHub Issues connector.
//!
//! It translates GitHub's REST API into the neutral connector contract. It
//! uses the person's own GitHub credential and permissions, sends nothing
//! ticketd-specific to GitHub, and never touches the workspace database.

mod credentials;
mod transport;

pub use credentials::{AmbientCredentials, CredentialSource, Secret};
pub use transport::{HttpRequest, HttpResponse, HttpTransport, Method, UreqTransport};

use serde_json::Value;

use super::{
    contract::{
        CONTRACT_VERSION, Capability, ClosureReason, ConnectionInfo, Connector,
        ConnectorDescriptor, Conversation, DiscoveryPage, DiscoveryRequest, ExternalComment,
        ExternalEvent, ExternalEventKind, ExternalIdentity, ExternalIssue, ExternalRef,
        ExternalState, PublicationCandidates, PublicationSearch, PublishRequest, SkippedPartition,
        SourceError,
    },
    schema::{
        ChoiceOption, ConfigSchema, ConfigValues, FieldKind, OptionSource, SchemaField, ValueFormat,
    },
};

pub const PROVIDER: &str = "github";
const DEFAULT_API_URL: &str = "https://api.github.com";
/// Overrides the API address, for GitHub Enterprise or a test server.
pub const API_URL_VARIABLE: &str = "TICKETD_GITHUB_API_URL";
const MAX_REDIRECTS: usize = 3;
const OPTION_PAGES: usize = 5;
const LABEL_REPOSITORIES: usize = 5;
/// Pages (of 100) read for one issue's comments or events before giving up.
const CONVERSATION_PAGES: usize = 50;
/// Pages (of 100) read when looking for a publication's issue before giving up.
const SEARCH_PAGES: usize = 5;

pub struct GithubConnector {
    api_url: String,
    transport: Box<dyn HttpTransport>,
    credentials: Box<dyn CredentialSource>,
}

impl GithubConnector {
    /// The connector as the application uses it: real network, ambient
    /// credentials, and the API address from [`API_URL_VARIABLE`] if set.
    pub fn ambient() -> Self {
        let custom = std::env::var(API_URL_VARIABLE)
            .ok()
            .map(|url| url.trim().trim_end_matches('/').to_owned())
            .filter(|url| !url.is_empty());
        // The GitHub CLI fallback only knows github.com.
        let ask_gh = custom.is_none();
        Self::new(
            custom.unwrap_or_else(|| DEFAULT_API_URL.to_owned()),
            Box::new(UreqTransport::new()),
            Box::new(AmbientCredentials::new(ask_gh)),
        )
    }

    pub fn new(
        api_url: impl Into<String>,
        transport: Box<dyn HttpTransport>,
        credentials: Box<dyn CredentialSource>,
    ) -> Self {
        Self {
            api_url: api_url.into().trim_end_matches('/').to_owned(),
            transport,
            credentials,
        }
    }

    fn schema() -> ConfigSchema {
        ConfigSchema {
            fields: vec![
                SchemaField {
                    key: "repositories".into(),
                    label: "Repositories".into(),
                    help: Some("Issues from these repositories are discovered.".into()),
                    required: true,
                    kind: FieldKind::MultiSelect {
                        options: OptionSource::Dynamic { depends_on: vec![] },
                        allow_custom: true,
                        min_items: 1,
                        max_items: 25,
                        format: Some(ValueFormat::OwnerName),
                    },
                },
                SchemaField {
                    key: "assignee".into(),
                    label: "Assignee".into(),
                    help: Some(
                        "Only issues assigned to this GitHub user. Leave empty for any assignee."
                            .into(),
                    ),
                    required: false,
                    kind: FieldKind::Text {
                        placeholder: Some("username".into()),
                        format: Some(ValueFormat::Handle),
                    },
                },
                SchemaField {
                    key: "labels".into(),
                    label: "Labels".into(),
                    help: Some(
                        "Only issues that have every one of these labels. Leave empty for any."
                            .into(),
                    ),
                    required: false,
                    kind: FieldKind::MultiSelect {
                        options: OptionSource::Dynamic {
                            depends_on: vec!["repositories".into()],
                        },
                        allow_custom: true,
                        min_items: 0,
                        max_items: 10,
                        format: Some(ValueFormat::Label),
                    },
                },
            ],
        }
    }

    /// Sends an authenticated GET and maps failures to [`SourceError`].
    /// `subject` names what was requested, for a useful not-found message.
    fn get(&self, url: &str, subject: &str) -> Result<HttpResponse, SourceError> {
        self.send(Method::Get, url, None, subject)
    }

    fn send(
        &self,
        method: Method,
        url: &str,
        body: Option<Vec<u8>>,
        subject: &str,
    ) -> Result<HttpResponse, SourceError> {
        let mut url = url.to_owned();
        for _ in 0..=MAX_REDIRECTS {
            if !self.is_api_url(&url) && url != self.graphql_url() {
                return Err(SourceError::Protocol(
                    "the source referred to an address outside its API".into(),
                ));
            }
            let token = self.credentials.token().ok_or_else(|| {
                SourceError::Unauthenticated(
                    "no GitHub credential found; run `gh auth login`, or set TICKETD_GITHUB_TOKEN to a token that can read issues".into(),
                )
            })?;
            let mut headers = vec![
                ("Accept".into(), "application/vnd.github+json".into()),
                ("X-GitHub-Api-Version".into(), "2022-11-28".into()),
                ("User-Agent".into(), "ticketd".into()),
                ("Authorization".into(), format!("Bearer {}", token.expose())),
            ];
            if body.is_some() {
                headers.push(("Content-Type".into(), "application/json".into()));
            }
            let request = HttpRequest {
                method,
                url: url.clone(),
                headers,
                body: body.clone(),
            };
            let response = self.transport.send(&request).map_err(|error| {
                SourceError::Unavailable(format!("could not reach GitHub: {error}"))
            })?;
            if matches!(response.status, 301 | 302 | 307 | 308) {
                let location = response
                    .header("location")
                    .ok_or_else(|| SourceError::Protocol("a redirect had no destination".into()))?;
                url = if location.starts_with('/') {
                    format!("{}{location}", self.api_url)
                } else {
                    location.to_owned()
                };
                continue;
            }
            return classify(response, subject);
        }
        Err(SourceError::Protocol("too many redirects".into()))
    }

    /// Creates an issue. A POST is never repeated or redirected: whether the
    /// first one took effect is the caller's question, so any answer other than
    /// a definite refusal or a readable 201 leaves creation unproven.
    fn create_issue(
        &self,
        repository: &str,
        request: &PublishRequest,
    ) -> Result<ExternalIssue, SourceError> {
        let token = self.credentials.token().ok_or_else(|| {
            SourceError::Unauthenticated(
                "no GitHub credential found; run `gh auth login`, or set TICKETD_GITHUB_TOKEN to a token that can create issues".into(),
            )
        })?;
        let body = serde_json::json!({ "title": request.title, "body": request.body });
        let http = HttpRequest {
            method: Method::Post,
            url: format!("{}/repos/{}/issues", self.api_url, encode_path(repository)),
            headers: vec![
                ("Accept".into(), "application/vnd.github+json".into()),
                ("X-GitHub-Api-Version".into(), "2022-11-28".into()),
                ("User-Agent".into(), "ticketd".into()),
                ("Content-Type".into(), "application/json".into()),
                ("Authorization".into(), format!("Bearer {}", token.expose())),
            ],
            body: Some(body.to_string().into_bytes()),
        };
        let response = self.transport.send(&http).map_err(|error| {
            // No answer: the request may or may not have been processed.
            SourceError::Unavailable(format!(
                "GitHub did not answer, so the issue may or may not have been created: {error}"
            ))
        })?;
        if response.status == 201 {
            let value: Value = serde_json::from_slice(&response.body).map_err(|_| {
                SourceError::Protocol("GitHub created the issue but the answer is not JSON".into())
            })?;
            return translate_issue(&value, repository)?
                .ok_or_else(|| SourceError::Protocol("GitHub's answer was not an issue".into()));
        }
        let subject = format!("creating an issue in {repository}");
        match response.status {
            // The request was understood and declined (validation, issues
            // disabled, gone): the shared classification would call these protocol errors.
            400 | 405 | 410 | 422 => {
                Err(SourceError::Rejected(match response_message(&response) {
                    Some(message) => format!("GitHub refused {subject}: {message}"),
                    None => format!("GitHub refused {subject} (status {})", response.status),
                }))
            }
            // Redirects, other 2xx and server errors prove nothing.
            _ => match classify(response, &subject) {
                Ok(_) => Err(SourceError::Protocol(
                    "GitHub answered the new issue with an unexpected success status".into(),
                )),
                Err(error) => Err(error),
            },
        }
    }

    /// GitHub Enterprise Server serves GraphQL beside, not under, its REST root.
    fn graphql_url(&self) -> String {
        match self.api_url.strip_suffix("/api/v3") {
            Some(host) => format!("{host}/api/graphql"),
            None => format!("{}/graphql", self.api_url),
        }
    }

    /// The canonical issue a duplicate was marked as a duplicate of.
    ///
    /// GitHub's REST issue payload and its timeline `marked_as_duplicate` event do
    /// not name the canonical issue; only GraphQL's `MarkedAsDuplicateEvent.canonical`
    /// does. A timeline also shows the event on the canonical issue, so only events
    /// whose `duplicate` is this issue count, and a later `UnmarkedAsDuplicateEvent`
    /// withdraws the target. Anything unavailable (no access, an error, a pull
    /// request as canonical) is "not supplied", never a failure of the fetch.
    fn canonical_of(&self, repository: &str, number: &str, id: u64) -> Option<ExternalRef> {
        let (owner, name) = repository.split_once('/')?;
        let body = serde_json::json!({
            "query": CANONICAL_QUERY,
            "variables": {"owner": owner, "name": name, "number": number.parse::<u64>().ok()?},
        })
        .to_string()
        .into_bytes();
        let response = self
            .send(
                Method::Post,
                &self.graphql_url(),
                Some(body),
                "duplicate timeline",
            )
            .ok()?;
        let value: Value = serde_json::from_slice(&response.body).ok()?;
        let nodes = value
            .pointer("/data/repository/issue/timelineItems/nodes")?
            .as_array()?;
        let mut target = None;
        for node in nodes {
            if node
                .pointer("/duplicate/databaseId")
                .and_then(Value::as_u64)
                != Some(id)
            {
                continue;
            }
            target = match node.get("__typename").and_then(Value::as_str) {
                Some("MarkedAsDuplicateEvent") => canonical_reference(node.get("canonical")?),
                Some("UnmarkedAsDuplicateEvent") => None,
                _ => continue,
            };
        }
        target
    }

    fn is_api_url(&self, url: &str) -> bool {
        url.strip_prefix(&self.api_url)
            .is_some_and(|rest| rest.starts_with('/'))
    }

    fn json(&self, url: &str, subject: &str) -> Result<(Value, Option<String>), SourceError> {
        let response = self.get(url, subject)?;
        let next = response.header("link").and_then(next_link);
        let value = serde_json::from_slice(&response.body)
            .map_err(|_| SourceError::Protocol("GitHub returned a body that is not JSON".into()))?;
        Ok((value, next))
    }

    fn repositories(config: &ConfigValues) -> Vec<String> {
        strings(config.get("repositories"))
    }
}

impl Connector for GithubConnector {
    fn descriptor(&self) -> ConnectorDescriptor {
        ConnectorDescriptor {
            provider: PROVIDER.into(),
            name: "GitHub".into(),
            contract_version: CONTRACT_VERSION,
            capabilities: vec![
                Capability::Discover,
                Capability::Fetch,
                Capability::Comments,
                Capability::Publish,
            ],
            schema: Self::schema(),
        }
    }

    fn check_connection(&self, _config: &ConfigValues) -> Result<ConnectionInfo, SourceError> {
        let (user, _) = self.json(
            &format!("{}/user", self.api_url),
            "the signed-in GitHub user",
        )?;
        let account = user
            .get("login")
            .and_then(Value::as_str)
            .ok_or_else(|| SourceError::Protocol("the user has no login".into()))?;
        Ok(ConnectionInfo {
            account: account.to_owned(),
        })
    }

    fn options(
        &self,
        field: &str,
        query: &str,
        config: &ConfigValues,
    ) -> Result<Vec<ChoiceOption>, SourceError> {
        let needle = query.to_lowercase();
        let mut options = Vec::new();
        match field {
            "repositories" => {
                let mut url = Some(format!(
                    "{}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
                    self.api_url
                ));
                for _ in 0..OPTION_PAGES {
                    let Some(current) = url.take() else { break };
                    let (page, next) = self.json(&current, "your repositories")?;
                    for repository in page.as_array().into_iter().flatten() {
                        let Some(name) = repository.get("full_name").and_then(Value::as_str) else {
                            continue;
                        };
                        if !name.to_lowercase().contains(&needle) {
                            continue;
                        }
                        let private = repository
                            .get("private")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        options.push(ChoiceOption {
                            value: name.to_owned(),
                            label: name.to_owned(),
                            description: Some(if private { "Private" } else { "Public" }.into()),
                        });
                    }
                    url = next;
                }
            }
            "labels" => {
                for repository in Self::repositories(config)
                    .into_iter()
                    .filter(|r| ValueFormat::OwnerName.is_valid(r))
                    .take(LABEL_REPOSITORIES)
                {
                    let url = format!(
                        "{}/repos/{}/labels?per_page=100",
                        self.api_url,
                        encode_path(&repository)
                    );
                    let (page, _) = self.json(&url, &format!("repository {repository}"))?;
                    for label in page.as_array().into_iter().flatten() {
                        let Some(name) = label.get("name").and_then(Value::as_str) else {
                            continue;
                        };
                        if name.to_lowercase().contains(&needle)
                            && !options.iter().any(|o: &ChoiceOption| o.value == name)
                        {
                            options.push(ChoiceOption {
                                value: name.to_owned(),
                                label: name.to_owned(),
                                description: None,
                            });
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(options)
    }

    fn discover(&self, request: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError> {
        let repositories = Self::repositories(request.config);
        let cursor = match request.cursor {
            Some(text) => Cursor::decode(text)?,
            None => Cursor::default(),
        };
        let Some(repository) = repositories.get(cursor.repository) else {
            return Ok(DiscoveryPage {
                issues: Vec::new(),
                next_cursor: None,
                skipped: Vec::new(),
            });
        };
        let url = match cursor.next {
            Some(url) => url,
            None => {
                let mut url = format!(
                    "{}/repos/{}/issues?state=open&per_page={}",
                    self.api_url,
                    encode_path(repository),
                    request.page_size.clamp(1, 100)
                );
                if let Some(assignee) = request.config.get("assignee").and_then(Value::as_str) {
                    url.push_str("&assignee=");
                    url.push_str(&encode_component(assignee));
                }
                let labels = strings(request.config.get("labels"));
                if !labels.is_empty() {
                    url.push_str("&labels=");
                    url.push_str(
                        &labels
                            .iter()
                            .map(|label| encode_component(label))
                            .collect::<Vec<_>>()
                            .join(","),
                    );
                }
                url
            }
        };
        let (page, next) = match self.json(&url, &format!("repository {repository}")) {
            Ok(found) => found,
            // One repository that is gone or closed to this account says nothing
            // about the others: skip it, say so, and carry on with the next.
            Err(error @ (SourceError::NotFound(_) | SourceError::Forbidden(_))) => {
                let next_cursor = (cursor.repository + 1 < repositories.len()).then(|| {
                    Cursor {
                        repository: cursor.repository + 1,
                        next: None,
                    }
                    .encode()
                });
                return Ok(DiscoveryPage {
                    issues: Vec::new(),
                    next_cursor,
                    skipped: vec![SkippedPartition {
                        code: error.code().to_owned(),
                        message: format!("{repository}: {error}"),
                    }],
                });
            }
            Err(error) => return Err(error),
        };
        let items = page
            .as_array()
            .ok_or_else(|| SourceError::Protocol("expected a list of issues".into()))?;
        let mut issues = Vec::new();
        for item in items {
            if let Some(issue) = translate_issue(item, repository)? {
                issues.push(issue);
            }
        }
        let next_cursor = match next {
            Some(url) => Some(
                Cursor {
                    repository: cursor.repository,
                    next: Some(url),
                }
                .encode(),
            ),
            None if cursor.repository + 1 < repositories.len() => Some(
                Cursor {
                    repository: cursor.repository + 1,
                    next: None,
                }
                .encode(),
            ),
            None => None,
        };
        Ok(DiscoveryPage {
            issues,
            next_cursor,
            skipped: Vec::new(),
        })
    }

    fn destinations(&self, config: &ConfigValues) -> Vec<String> {
        Self::repositories(config)
    }

    fn publish(
        &self,
        _config: &ConfigValues,
        request: &PublishRequest,
    ) -> Result<ExternalIssue, SourceError> {
        if !ValueFormat::OwnerName.is_valid(&request.destination) {
            return Err(SourceError::InvalidConfiguration(vec![
                super::schema::FieldIssue {
                    field: "destination".into(),
                    message: "must be a repository in the form owner/name".into(),
                },
            ]));
        }
        self.create_issue(&request.destination, request)
    }

    fn locate(
        &self,
        _config: &ConfigValues,
        destination: &str,
        text: &str,
    ) -> Result<ExternalIssue, SourceError> {
        let number = issue_number_in(text, destination)?;
        let url = format!(
            "{}/repos/{}/issues/{number}",
            self.api_url,
            encode_path(destination)
        );
        let (value, _) = self.json(&url, &format!("issue {destination}#{number}"))?;
        let issue = translate_issue(&value, destination)?.ok_or_else(|| {
            SourceError::NotFound(format!(
                "{destination}#{number} is a pull request, not an issue"
            ))
        })?;
        // An issue transferred elsewhere still answers here; it is not in the destination.
        let repository = issue.display.rsplit_once('#').map_or("", |(repo, _)| repo);
        if !repository.eq_ignore_ascii_case(destination) {
            return Err(not_in_destination(destination));
        }
        Ok(issue)
    }

    fn find_published(
        &self,
        _config: &ConfigValues,
        search: &PublicationSearch,
    ) -> Result<PublicationCandidates, SourceError> {
        let destination = &search.request.destination;
        if !ValueFormat::OwnerName.is_valid(destination) {
            return Err(SourceError::InvalidConfiguration(vec![
                super::schema::FieldIssue {
                    field: "destination".into(),
                    message: "must be a repository in the form owner/name".into(),
                },
            ]));
        }
        let since = chrono::DateTime::parse_from_rfc3339(&search.since).ok();
        let mut url = Some(format!(
            "{}/repos/{}/issues?state=all&sort=created&direction=desc&per_page=100&since={}",
            self.api_url,
            encode_path(destination),
            encode_component(&search.since)
        ));
        let subject = format!("repository {destination}");
        let mut matches = Vec::new();
        for _ in 0..SEARCH_PAGES {
            let Some(current) = url.take() else {
                break;
            };
            let (page, next) = self.json(&current, &subject)?;
            let items = page
                .as_array()
                .ok_or_else(|| SourceError::Protocol("expected a list of issues".into()))?;
            for item in items {
                let Some(issue) = translate_issue(item, destination)? else {
                    continue;
                };
                // Newest first: the first issue older than the window ends the read.
                let created = chrono::DateTime::parse_from_rfc3339(&issue.created_at).ok();
                if let (Some(created), Some(since)) = (created, since)
                    && created < since
                {
                    return Ok(PublicationCandidates {
                        matches,
                        complete: true,
                    });
                }
                if could_be_published(&issue, &search.request) {
                    matches.push(issue);
                }
            }
            url = next;
        }
        Ok(PublicationCandidates {
            matches,
            complete: url.is_none(),
        })
    }

    fn fetch(
        &self,
        _config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        let (repository, number) = split_locator(&reference.locator)?;
        let url = format!(
            "{}/repos/{}/issues/{number}",
            self.api_url,
            encode_path(repository)
        );
        let (value, _) = self.json(&url, &format!("issue {}", reference.locator))?;
        let mut issue = translate_issue(&value, repository)?.ok_or_else(|| {
            SourceError::NotFound(format!(
                "{} is a pull request, not an issue",
                reference.locator
            ))
        })?;
        if issue.state
            == (ExternalState::Closed {
                reason: ClosureReason::Duplicate,
            })
        {
            let id = issue.reference.identity.id.parse().unwrap_or_default();
            issue.duplicate_of = self.canonical_of(repository, number, id);
        }
        Ok(issue)
    }

    fn conversation(
        &self,
        _config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<Conversation, SourceError> {
        let (repository, number) = split_locator(&reference.locator)?;
        let subject = format!("issue {}", reference.locator);
        let base = format!(
            "{}/repos/{}/issues/{number}",
            self.api_url,
            encode_path(repository)
        );
        let mut conversation = Conversation::default();
        for item in self.all_pages(&format!("{base}/comments?per_page=100"), &subject)? {
            conversation.comments.push(translate_comment(&item)?);
        }
        for item in self.all_pages(&format!("{base}/events?per_page=100"), &subject)? {
            if let Some(event) = translate_event(&item)? {
                conversation.events.push(event);
            }
        }
        Ok(conversation)
    }
}

impl GithubConnector {
    /// Every item of a paginated list, following `Link` headers that stay under the API.
    fn all_pages(&self, first: &str, subject: &str) -> Result<Vec<Value>, SourceError> {
        let mut items = Vec::new();
        let mut url = Some(first.to_owned());
        for _ in 0..CONVERSATION_PAGES {
            let Some(current) = url.take() else {
                return Ok(items);
            };
            let (page, next) = self.json(&current, subject)?;
            items.extend(
                page.as_array()
                    .ok_or_else(|| SourceError::Protocol("expected a list".into()))?
                    .iter()
                    .cloned(),
            );
            url = next;
        }
        match url {
            None => Ok(items),
            Some(_) => Err(SourceError::Protocol(
                "the conversation has too many pages to read".into(),
            )),
        }
    }
}

fn not_in_destination(destination: &str) -> SourceError {
    SourceError::InvalidConfiguration(vec![super::schema::FieldIssue {
        field: "issue".into(),
        message: format!("is not in {destination}"),
    }])
}

/// The issue number in `text`, which may be `12`, `#12`, `owner/name#12` or an
/// issue link, provided it names `destination` (compared without case).
fn issue_number_in(text: &str, destination: &str) -> Result<u64, SourceError> {
    let text = text.trim();
    let invalid = || {
        SourceError::InvalidConfiguration(vec![super::schema::FieldIssue {
            field: "issue".into(),
            message: "must be an issue number, owner/name#number or an issue link".into(),
        }])
    };
    let (repository, number) = if let Some((_, path)) = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"))
        .and_then(|rest| rest.split_once('/'))
    {
        let path = path.split(['?', '#']).next().unwrap_or_default();
        let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
        match parts.as_slice() {
            [owner, name, "issues", number] => (Some(format!("{owner}/{name}")), *number),
            _ => return Err(invalid()),
        }
    } else if let Some((repository, number)) = text.rsplit_once('#') {
        (
            Some(repository.to_owned()).filter(|r| !r.is_empty()),
            number,
        )
    } else {
        (None, text)
    };
    let number: u64 = number.parse().map_err(|_| invalid())?;
    if number == 0 {
        return Err(invalid());
    }
    if let Some(repository) = repository
        && !repository.eq_ignore_ascii_case(destination)
    {
        return Err(not_in_destination(destination));
    }
    Ok(number)
}

/// Whether `issue` could be the one `request` created: same title, or the same
/// non-empty description (GitHub may normalize line endings and trim).
fn could_be_published(issue: &ExternalIssue, request: &PublishRequest) -> bool {
    let plain = |text: &str| text.replace("\r\n", "\n").trim().to_owned();
    plain(&issue.title) == plain(&request.title)
        || (!plain(&request.body).is_empty() && plain(&issue.body) == plain(&request.body))
}

fn split_locator(locator: &str) -> Result<(&str, &str), SourceError> {
    locator
        .rsplit_once('#')
        .filter(|(repository, number)| {
            ValueFormat::OwnerName.is_valid(repository)
                && !number.is_empty()
                && number.chars().all(|c| c.is_ascii_digit())
        })
        .ok_or_else(|| SourceError::Protocol("the issue locator is not valid".into()))
}

fn translate_comment(item: &Value) -> Result<ExternalComment, SourceError> {
    let text = |key: &str| item.get(key).and_then(Value::as_str);
    let id = item
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| SourceError::Protocol("a comment had no id".into()))?;
    let created_at = text("created_at").unwrap_or_default().to_owned();
    Ok(ExternalComment {
        id: id.to_string(),
        // GitHub reports a deleted account's comments with no user.
        author: item
            .get("user")
            .and_then(|user| user.get("login"))
            .and_then(Value::as_str)
            .unwrap_or("ghost")
            .to_owned(),
        body: text("body").unwrap_or_default().to_owned(),
        url: text("html_url").unwrap_or_default().to_owned(),
        updated_at: text("updated_at").map_or_else(|| created_at.clone(), str::to_owned),
        created_at,
    })
}

/// Only the events the design shows; labels, milestones, references and the
/// rest are not part of the conversation.
fn translate_event(item: &Value) -> Result<Option<ExternalEvent>, SourceError> {
    let kind = match item.get("event").and_then(Value::as_str) {
        Some("closed") => {
            ExternalEventKind::Closed(match item.get("state_reason").and_then(Value::as_str) {
                Some("completed") => ClosureReason::Completed,
                Some("not_planned") => ClosureReason::NotPlanned,
                Some("duplicate") => ClosureReason::Duplicate,
                _ => ClosureReason::Unknown,
            })
        }
        Some("reopened") => ExternalEventKind::Reopened,
        Some("assigned") => ExternalEventKind::Assigned,
        Some("unassigned") => ExternalEventKind::Unassigned,
        _ => return Ok(None),
    };
    let id = item
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| SourceError::Protocol("an event had no id".into()))?;
    let login = |key: &str| {
        item.get(key)
            .and_then(|who| who.get("login"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Ok(Some(ExternalEvent {
        id: id.to_string(),
        kind,
        actor: login("actor"),
        subject: login("assignee"),
        created_at: item
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    }))
}

const CANONICAL_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { \
repository(owner: $owner, name: $name) { issue(number: $number) { \
timelineItems(last: 50, itemTypes: [MARKED_AS_DUPLICATE_EVENT, UNMARKED_AS_DUPLICATE_EVENT]) { nodes { \
__typename \
... on MarkedAsDuplicateEvent { duplicate { ... on Issue { databaseId } } \
canonical { __typename ... on Issue { databaseId number repository { nameWithOwner } } } } \
... on UnmarkedAsDuplicateEvent { duplicate { ... on Issue { databaseId } } } } } } } }";

/// An issue named as canonical, or `None` for anything ticketd cannot track
/// (a pull request, or a target the credential cannot read).
fn canonical_reference(canonical: &Value) -> Option<ExternalRef> {
    if canonical.get("__typename").and_then(Value::as_str) != Some("Issue") {
        return None;
    }
    let id = canonical.get("databaseId").and_then(Value::as_u64)?;
    let number = canonical.get("number").and_then(Value::as_u64)?;
    let repository = canonical.pointer("/repository/nameWithOwner")?.as_str()?;
    Some(ExternalRef {
        identity: ExternalIdentity {
            provider: PROVIDER.into(),
            id: id.to_string(),
        },
        locator: format!("{repository}#{number}"),
    })
}

#[derive(Default)]
struct Cursor {
    repository: usize,
    next: Option<String>,
}

impl Cursor {
    fn encode(&self) -> String {
        serde_json::json!({ "repository": self.repository, "next": self.next }).to_string()
    }

    fn decode(text: &str) -> Result<Self, SourceError> {
        let invalid = || SourceError::Protocol("the paging position is not valid".into());
        let value: Value = serde_json::from_str(text).map_err(|_| invalid())?;
        let repository = value
            .get("repository")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(invalid)?;
        let next = match value.get("next") {
            Some(Value::String(url)) => Some(url.clone()),
            _ => None,
        };
        Ok(Self { repository, next })
    }
}

fn classify(response: HttpResponse, subject: &str) -> Result<HttpResponse, SourceError> {
    let status = response.status;
    if (200..300).contains(&status) {
        return Ok(response);
    }
    let message = response_message(&response);
    let detail = |text: &str| match &message {
        Some(message) => format!("{text}: {message}"),
        None => text.to_owned(),
    };
    match status {
        401 => Err(SourceError::Unauthenticated(detail(
            "GitHub rejected the credential; run `gh auth login` or set TICKETD_GITHUB_TOKEN to a valid token",
        ))),
        403 | 429 => {
            let limited = status == 429
                || response.header("x-ratelimit-remaining") == Some("0")
                || response.header("retry-after").is_some()
                || message
                    .as_deref()
                    .is_some_and(|m| m.to_lowercase().contains("rate limit"));
            if limited {
                Err(SourceError::RateLimited {
                    retry_after_secs: retry_after(&response),
                })
            } else {
                Err(SourceError::Forbidden(detail(&format!(
                    "GitHub denied access to {subject}; the credential needs permission to read issues there"
                ))))
            }
        }
        // 410 Gone (a deleted issue, or a repository with issues disabled) is an
        // answer about that one resource, the same as not found.
        404 | 410 => Err(SourceError::NotFound(format!(
            "{subject} was not found, or the credential cannot see it"
        ))),
        500..=599 => Err(SourceError::Unavailable(format!(
            "GitHub is unavailable (status {status}); retry later"
        ))),
        _ => Err(SourceError::Protocol(detail(&format!(
            "GitHub answered {subject} with status {status}"
        )))),
    }
}

fn response_message(response: &HttpResponse) -> Option<String> {
    let value: Value = serde_json::from_slice(&response.body).ok()?;
    let message = value.get("message")?.as_str()?;
    Some(message.chars().take(200).collect())
}

fn retry_after(response: &HttpResponse) -> Option<u64> {
    if let Some(seconds) = response
        .header("retry-after")
        .and_then(|v| v.trim().parse().ok())
    {
        return Some(seconds);
    }
    let reset: u64 = response.header("x-ratelimit-reset")?.trim().parse().ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(reset.saturating_sub(now))
}

/// The `rel="next"` target of a `Link` header.
fn next_link(header: &str) -> Option<String> {
    header.split(',').find_map(|part| {
        let (target, parameters) = part.split_once(';')?;
        let is_next = parameters
            .split(';')
            .any(|p| p.trim().replace(' ', "") == "rel=\"next\"");
        let target = target.trim().strip_prefix('<')?.strip_suffix('>')?;
        is_next.then(|| target.to_owned())
    })
}

/// Translates one item of GitHub's issues list. Pull requests, which that
/// endpoint also returns, are not tickets and yield `None`.
fn translate_issue(
    item: &Value,
    requested_repository: &str,
) -> Result<Option<ExternalIssue>, SourceError> {
    if item.get("pull_request").is_some() {
        return Ok(None);
    }
    let missing = |what: &str| SourceError::Protocol(format!("an issue had no {what}"));
    let id = item
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| missing("id"))?;
    let number = item
        .get("number")
        .and_then(Value::as_u64)
        .ok_or_else(|| missing("number"))?;
    let text = |key: &str| item.get(key).and_then(Value::as_str);
    let title = text("title").ok_or_else(|| missing("title"))?;
    let state = match text("state") {
        Some("open") => ExternalState::Open,
        Some("closed") => ExternalState::Closed {
            reason: match text("state_reason") {
                Some("completed") => ClosureReason::Completed,
                Some("not_planned") => ClosureReason::NotPlanned,
                Some("duplicate") => ClosureReason::Duplicate,
                _ => ClosureReason::Unknown,
            },
        },
        _ => return Err(missing("recognized state")),
    };
    let repository = text("repository_url")
        .and_then(|url| url.split_once("/repos/").map(|(_, name)| name))
        .unwrap_or(requested_repository);
    let display = format!("{repository}#{number}");
    Ok(Some(ExternalIssue {
        reference: ExternalRef {
            identity: ExternalIdentity {
                provider: PROVIDER.into(),
                id: id.to_string(),
            },
            locator: display.clone(),
        },
        display,
        url: text("html_url").unwrap_or_default().to_owned(),
        title: title.to_owned(),
        body: text("body").unwrap_or_default().to_owned(),
        state,
        assignees: item
            .get("assignees")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|a| a.get("login").and_then(Value::as_str).map(str::to_owned))
            .collect(),
        labels: item
            .get("labels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|label| {
                label
                    .as_str()
                    .or_else(|| label.get("name").and_then(Value::as_str))
                    .map(str::to_owned)
            })
            .collect(),
        created_at: text("created_at").unwrap_or_default().to_owned(),
        updated_at: text("updated_at").unwrap_or_default().to_owned(),
        // The issue payload does not name the canonical issue; `fetch` looks it up.
        duplicate_of: None,
    }))
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

fn encode_component(text: &str) -> String {
    let mut encoded = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(encode_component)
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests;
