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
        ConnectorDescriptor, DiscoveryPage, DiscoveryRequest, ExternalIdentity, ExternalIssue,
        ExternalRef, ExternalState, SourceError,
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
        let mut url = url.to_owned();
        for _ in 0..=MAX_REDIRECTS {
            if !self.is_api_url(&url) {
                return Err(SourceError::Protocol(
                    "the source referred to an address outside its API".into(),
                ));
            }
            let token = self.credentials.token().ok_or_else(|| {
                SourceError::Unauthenticated(
                    "no GitHub credential found; run `gh auth login`, or set TICKETD_GITHUB_TOKEN to a token that can read issues".into(),
                )
            })?;
            let request = HttpRequest {
                method: Method::Get,
                url: url.clone(),
                headers: vec![
                    ("Accept".into(), "application/vnd.github+json".into()),
                    ("X-GitHub-Api-Version".into(), "2022-11-28".into()),
                    ("User-Agent".into(), "ticketd".into()),
                    ("Authorization".into(), format!("Bearer {}", token.expose())),
                ],
                body: None,
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
            name: "GitHub Issues".into(),
            contract_version: CONTRACT_VERSION,
            capabilities: vec![Capability::Discover, Capability::Fetch],
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
        let (page, next) = self.json(&url, &format!("repository {repository}"))?;
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
        })
    }

    fn fetch(
        &self,
        _config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        let (repository, number) = reference
            .locator
            .rsplit_once('#')
            .filter(|(repository, number)| {
                ValueFormat::OwnerName.is_valid(repository)
                    && !number.is_empty()
                    && number.chars().all(|c| c.is_ascii_digit())
            })
            .ok_or_else(|| SourceError::Protocol("the issue locator is not valid".into()))?;
        let url = format!(
            "{}/repos/{}/issues/{number}",
            self.api_url,
            encode_path(repository)
        );
        let (value, _) = self.json(&url, &format!("issue {}", reference.locator))?;
        translate_issue(&value, repository)?.ok_or_else(|| {
            SourceError::NotFound(format!(
                "{} is a pull request, not an issue",
                reference.locator
            ))
        })
    }
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
        404 => Err(SourceError::NotFound(format!(
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
