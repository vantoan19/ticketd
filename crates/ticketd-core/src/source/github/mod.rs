//! The built-in GitHub Issues connector.
//!
//! It translates GitHub's REST API into the neutral connector contract. It
//! uses the person's own GitHub credential and permissions, sends nothing
//! ticketd-specific to GitHub, and never touches the workspace database.

mod credentials;
mod transport;

use credentials::{AmbientCredentials, CredentialSource};
use transport::{HttpRequest, HttpResponse, HttpTransport, Method, UreqTransport};

use serde_json::Value;

use super::{
    FieldPresentation, IssueName, PullRequestLink, SignInGuidance, SourcePresentation, SummaryPart,
    TargetPresentation,
    contract::{
        CONTRACT_VERSION, Capability, ConnectionCheck, ConnectionInfo, Connector,
        ConnectorDescriptor, Conversation, DerivedConfiguration, DestinationRules,
        DestinationValidation, DiscoveryPage, DiscoveryRequest, ExternalComment, ExternalEvent,
        ExternalEventKind, ExternalIdentity, ExternalIssue, ExternalRef, ExternalState,
        FetchedIssue, Publication, PublicationCandidates, PublicationSearch, PublishRequest,
        SkippedPartition, SourceError, StateCategory, check_publication_deadline,
    },
    schema::{
        ChoiceOption, ConfigSchema, ConfigValues, FieldIssue, FieldKind, FieldPattern,
        OptionSource, SchemaField, ValueFormat,
    },
};

pub(crate) const PROVIDER: &str = "github";
/// What people call this provider.
pub(crate) const DISPLAY_NAME: &str = "GitHub";
const DEFAULT_API_URL: &str = "https://api.github.com";
/// Overrides the API address, for GitHub Enterprise or a test server.
pub(crate) const API_URL_VARIABLE: &str = "TICKETD_GITHUB_API_URL";
const MAX_REDIRECTS: usize = 3;
const OPTION_PAGES: usize = 5;
const LABEL_REPOSITORIES: usize = 5;
/// Pages (of 100) read for one issue's comments or events before giving up.
const CONVERSATION_PAGES: usize = 50;
/// Pages (of 100) read when looking for a publication's issue before giving up.
const SEARCH_PAGES: usize = 5;

pub(crate) struct GithubConnector {
    api_url: String,
    web_site: Option<String>,
    pinned_token_variable: Option<String>,
    transport: Box<dyn HttpTransport>,
    credentials: Box<dyn CredentialSource>,
    ambient: bool,
}

impl GithubConnector {
    /// The connector as the application uses it: real network, ambient
    /// credentials, and the API address from [`API_URL_VARIABLE`] if set.
    pub(crate) fn ambient() -> Self {
        Self::ambient_for(None, None)
    }

    fn ambient_for(id: Option<&str>, account: Option<&str>) -> Self {
        let custom = configured_api_url();
        // github.com tokens are for github.com: another host gets its own.
        let custom_host = custom
            .as_deref()
            .map(|url| host_of(url).to_ascii_lowercase());
        let mut connector = Self::new(
            custom.unwrap_or_else(|| DEFAULT_API_URL.to_owned()),
            Box::new(UreqTransport::new()),
            Box::new(AmbientCredentials::new(custom_host, id, account)),
        );
        connector.ambient = true;
        connector.pinned_token_variable = account
            .zip(id)
            .map(|(_, id)| credentials::connection_token_variable(id));
        connector
    }

    pub(crate) fn new(
        api_url: impl Into<String>,
        transport: Box<dyn HttpTransport>,
        credentials: Box<dyn CredentialSource>,
    ) -> Self {
        let api_url = api_url.into().trim_end_matches('/').to_owned();
        let web_site = url::Url::parse(&api_url)
            .ok()
            .and_then(|api| web_site(&api));
        Self {
            api_url,
            web_site,
            pinned_token_variable: None,
            transport,
            credentials,
            ambient: false,
        }
    }

    fn site(&self) -> String {
        site_of(&self.api_url)
    }

    fn issue_identity(&self, id: u64) -> Result<ExternalIdentity, SourceError> {
        let host = self
            .web_site
            .as_deref()
            .ok_or_else(|| SourceError::Protocol("the GitHub API has no valid host".into()))?;
        Ok(ExternalIdentity {
            provider: PROVIDER.into(),
            id: issue_id(&id.to_string(), host),
        })
    }

    fn check_issue_host(&self, reference: &ExternalRef) -> Result<(), SourceError> {
        let host = issue_id_site(&reference.identity.id);
        if let (Some(host), Some(configured)) = (host, self.web_site.as_deref()) {
            if host == configured {
                return Ok(());
            }
            return Err(SourceError::NotFound(format!(
                "{} belongs to GitHub host {host}; the current source uses {configured}",
                reference.locator
            )));
        }
        Err(SourceError::NotFound(format!(
            "the GitHub host of {} could not be identified",
            reference.locator
        )))
    }

    fn schema() -> ConfigSchema {
        ConfigSchema {
            fields: vec![
                SchemaField {
                    key: "repositories".into(),
                    label: "Repositories".into(),
                    help: Some("Issues from these repositories are discovered, and tickets can be published only to them. Type owner/name, then press Enter.".into()),
                    required: true,
                    placeholder: Some("e.g. acme/billing-api".into()),
                    pattern: None,
                    advanced: false,
                    show_if: None,
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
                    placeholder: Some("e.g. octocat".into()),
                    pattern: Some(FieldPattern {
                        regex: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$".into(),
                        message: "must be a username of letters, digits and hyphens".into(),
                    }),
                    advanced: false,
                    show_if: None,
                    kind: FieldKind::Text { format: None },
                },
                SchemaField {
                    key: "labels".into(),
                    label: "Labels".into(),
                    help: Some(
                        "Only issues that have every one of these labels. Leave empty for any."
                            .into(),
                    ),
                    required: false,
                    placeholder: Some("e.g. bug, payments".into()),
                    pattern: None,
                    advanced: false,
                    show_if: None,
                    kind: FieldKind::MultiSelect {
                        options: OptionSource::Dynamic {
                            depends_on: vec!["repositories".into()],
                        },
                        allow_custom: true,
                        min_items: 0,
                        max_items: 10,
                        format: None,
                    },
                },
                SchemaField {
                    key: "account".into(),
                    label: "GitHub CLI account".into(),
                    help: Some("Choose a username already signed in with gh. Leave empty to use the active account.".into()),
                    required: false,
                    placeholder: Some("e.g. octocat".into()),
                    pattern: None,
                    advanced: true,
                    show_if: None,
                    kind: FieldKind::Text { format: Some(ValueFormat::Handle) },
                },
            ],
        }
    }

    /// Sends an authenticated GET and maps failures to [`SourceError`].
    /// `subject` names what was requested, for a useful not-found message.
    fn get(&self, url: &str, subject: &str) -> Result<HttpResponse, SourceError> {
        self.send(Method::Get, url, None, subject)
            .map(|(response, _)| response)
    }

    fn send(
        &self,
        method: Method,
        url: &str,
        body: Option<Vec<u8>>,
        subject: &str,
    ) -> Result<(HttpResponse, Option<String>), SourceError> {
        if !credential_may_travel(&self.api_url) {
            return Err(SourceError::InvalidConfiguration(vec![
                super::schema::FieldIssue::for_field(
                    API_URL_VARIABLE,
                    "must be an https address (plain http is allowed only for localhost), so a credential is never sent in the clear",
                ),
            ]));
        }
        let mut url = url.to_owned();
        let mut permanent_issue_redirect =
            method == Method::Get && self.issue_api_locator(&url).is_some();
        for redirects in 0..=MAX_REDIRECTS {
            if !self.is_api_url(&url) && url != self.graphql_url() {
                return Err(SourceError::Protocol(
                    "the source referred to an address outside its API".into(),
                ));
            }
            let token = self.credentials.token().ok_or_else(missing_credential)?;
            let headers = request_headers(&token, body.is_some());
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
                    url::Url::parse(&url)
                        .and_then(|base| base.join(location))
                        .map_err(|_| {
                            SourceError::Protocol("a redirect had an invalid destination".into())
                        })?
                        .to_string()
                } else {
                    location.to_owned()
                };
                permanent_issue_redirect &=
                    matches!(response.status, 301 | 308) && self.issue_api_locator(&url).is_some();
                continue;
            }
            let target = (redirects > 0 && permanent_issue_redirect && response.status == 200)
                .then_some(url);
            return Ok((classify(response, subject)?, target));
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
        deadline: Option<std::time::Instant>,
    ) -> Result<ExternalIssue, SourceError> {
        require_repository(repository)?;
        let token = self.credentials.token().ok_or_else(missing_credential)?;
        let body = serde_json::json!({ "title": request.title, "body": request.body });
        let http = HttpRequest {
            method: Method::Post,
            url: format!("{}/repos/{}/issues", self.api_url, encode_path(repository)),
            headers: request_headers(&token, true),
            body: Some(body.to_string().into_bytes()),
        };
        check_publication_deadline(deadline)?;
        let response = self.transport.send(&http).map_err(|error| {
            if error.before_send {
                // The request never left: nothing can have been created.
                SourceError::NotSent(format!(
                    "could not reach GitHub, so nothing was sent: {error}"
                ))
            } else {
                // No answer: the request may or may not have been processed.
                SourceError::Unavailable(format!(
                    "GitHub did not answer, so the issue may or may not have been created: {error}"
                ))
            }
        })?;
        if response.status == 201 {
            let value: Value = serde_json::from_slice(&response.body).map_err(|_| {
                SourceError::Protocol("GitHub created the issue but the answer is not JSON".into())
            })?;
            return translate_issue(self, &value, repository)?
                .ok_or_else(|| SourceError::Protocol("GitHub's answer was not an issue".into()));
        }
        let subject = format!("creating an issue in {repository}");
        match response.status {
            // The request was understood and declined (validation, issues
            // disabled, gone): the shared classification would call these protocol errors.
            status @ (400 | 405 | 410 | 422) => Err(SourceError::Rejected(format!(
                "GitHub refused {subject}; check that issues are enabled and the ticket content is accepted"
            ))
            .with_detail(format_args!("HTTP {status}"))),
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
    /// not name the canonical issue; only GraphQL does. Closing as "duplicate of #N"
    /// records it on this issue's own `ClosedEvent.duplicateOf`; marking records it
    /// on `MarkedAsDuplicateEvent.canonical`, which a timeline also shows on the
    /// canonical issue, so only marked events whose `duplicate` is this issue count.
    /// The latest event wins, and a later `UnmarkedAsDuplicateEvent` withdraws the
    /// target. Anything unavailable (no access, an error, a pull
    /// request as canonical) is "not supplied", never a failure of the fetch.
    fn canonical_of(&self, repository: &str, number: &str, id: u64) -> Canonical {
        self.look_up_canonical(repository, number, id)
            .unwrap_or(Canonical::NotSupplied)
    }

    fn look_up_canonical(&self, repository: &str, number: &str, id: u64) -> Option<Canonical> {
        let (owner, name) = repository.split_once('/')?;
        let body = serde_json::json!({
            "query": CANONICAL_QUERY,
            "variables": {"owner": owner, "name": name, "number": number.parse::<u64>().ok()?},
        })
        .to_string()
        .into_bytes();
        let (response, _) = self
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
        let mut target = Canonical::NotSupplied;
        for node in nodes {
            // Closing as "duplicate of #N" records the canonical on this issue's own
            // closed event; the marked event then appears only on the canonical's
            // timeline. A closure that names no issue leaves an earlier mark standing.
            if node.get("__typename").and_then(Value::as_str) == Some("ClosedEvent") {
                if let Some((reference, url)) = node
                    .get("duplicateOf")
                    .and_then(|issue| canonical_reference(self, issue))
                {
                    target = Canonical::Named { reference, url };
                }
                continue;
            }
            if node
                .pointer("/duplicate/databaseId")
                .and_then(Value::as_u64)
                != Some(id)
            {
                continue;
            }
            target = match node.get("__typename").and_then(Value::as_str) {
                Some("MarkedAsDuplicateEvent") => canonical_reference(self, node.get("canonical")?)
                    .map_or(Canonical::NotSupplied, |(reference, url)| {
                        Canonical::Named { reference, url }
                    }),
                // A definite withdrawal, not a missing answer.
                Some("UnmarkedAsDuplicateEvent") => Canonical::Withdrawn,
                _ => continue,
            };
        }
        Some(target)
    }

    fn is_api_url(&self, url: &str) -> bool {
        url.strip_prefix(&self.api_url)
            .is_some_and(|rest| rest.starts_with('/'))
    }

    fn issue_api_locator(&self, url: &str) -> Option<String> {
        let path = url.strip_prefix(&self.api_url)?.strip_prefix("/repos/")?;
        let (repository, number) = path.rsplit_once("/issues/")?;
        let locator = format!("{repository}#{number}");
        split_locator(&locator).ok()?;
        if repository.split('/').any(|part| matches!(part, "." | ".."))
            || number.parse::<u64>().ok()? == 0
        {
            return None;
        }
        Some(locator)
    }

    fn json(&self, url: &str, subject: &str) -> Result<(Value, Option<String>), SourceError> {
        let response = self.get(url, subject)?;
        let next = response.header("link").and_then(next_link);
        Ok((response_json(&response)?, next))
    }

    fn repositories(config: &ConfigValues) -> Vec<String> {
        strings(config.get("repositories"))
    }
}

impl Connector for GithubConnector {
    fn for_connection(&self, id: &str, config: &ConfigValues) -> Option<Box<dyn Connector>> {
        let account = config
            .get("account")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| ValueFormat::Handle.is_valid(name));
        self.ambient
            .then(|| Box::new(Self::ambient_for(Some(id), account)) as Box<dyn Connector>)
    }

    fn effective_site(&self) -> Option<String> {
        Some(self.site())
    }

    fn issue_site(&self) -> Option<&str> {
        self.web_site.as_deref()
    }

    fn descriptor(&self) -> ConnectorDescriptor {
        ConnectorDescriptor {
            provider: PROVIDER.into(),
            name: DISPLAY_NAME.into(),
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

    fn presentation(&self) -> SourcePresentation {
        SourcePresentation {
            icon_svg: Some(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/></svg>"#.into()),
            issue_name: IssueName {
                separator: "#".into(),
                separator_in_number: true,
                place_separator: Some("/".into()),
            },
            sign_in: SignInGuidance {
                terminal_hint: Some(match &self.pinned_token_variable {
                    Some(variable) => format!("Sign in as the GitHub CLI account selected for this connection, or set {variable} to a token for that account."),
                    None => "From a script, set TICKETD_GITHUB_TOKEN to a token that can read and create issues instead.".into(),
                }),
                desktop_hint: Some("Then choose Check connection in Settings › Ticket sources.".into()),
                desktop_instruction: Some("Run “gh auth login” in a terminal, then choose Check connection.".into()),
            },
            fields: [
                ("repositories".into(), FieldPresentation {
                    placeholder: Some("e.g. acme/billing-api".into()),
                    additional_placeholder: Some("Add another repository".into()),
                }),
                ("assignee".into(), FieldPresentation {
                    placeholder: Some("e.g. octocat".into()),
                    additional_placeholder: None,
                }),
                ("labels".into(), FieldPresentation {
                    placeholder: Some("e.g. bug, payments".into()),
                    additional_placeholder: None,
                }),
            ].into(),
            target: Some(TargetPresentation {
                field: "repositories".into(),
                label: "Repository".into(),
                example: "owner/name".into(),
                choose: "Choose a repository".into(),
                add: "Add a repository".into(),
            }),
            discovery_note: Some("Pull requests are not included.".into()),
            pull_request_link: Some(PullRequestLink {
                host: "github.com".into(),
                segment: "pull".into(),
            }),
            hosts: vec![host_of(&self.api_url)],
        }
    }

    fn configuration_summary(&self, config: &ConfigValues) -> Vec<SummaryPart> {
        let repositories = Self::repositories(config);
        let labels = strings(config.get("labels"));
        let assignee = config
            .get("assignee")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let plain = |text: &str| SummaryPart {
            text: text.into(),
            emphasis: false,
        };
        let emphasis = |text: String| SummaryPart {
            text,
            emphasis: true,
        };
        let mut summary = vec![
            plain("Imports open issues from "),
            emphasis(if repositories.is_empty() {
                "no repository yet".into()
            } else {
                repositories.join(", ")
            }),
        ];
        if let Some((last, rest)) = labels.split_last() {
            summary.push(plain(if rest.is_empty() {
                " that have the label "
            } else {
                " that have the labels "
            }));
            summary.push(emphasis(if rest.is_empty() {
                last.clone()
            } else {
                format!("{} and {last}", rest.join(", "))
            }));
        }
        summary.push(plain(", assigned to "));
        summary.push(emphasis(
            if assignee.is_empty() {
                "anyone"
            } else {
                assignee
            }
            .into(),
        ));
        summary.push(plain("."));
        summary
    }

    fn validate(&self, config: &ConfigValues) -> Result<Vec<FieldIssue>, SourceError> {
        let mut issues = Vec::new();
        if let Some(assignee) = config.get("assignee").and_then(Value::as_str)
            && !ValueFormat::Handle.is_valid(assignee)
        {
            issues.push(FieldIssue::for_field(
                "assignee",
                "must be a username of letters, digits and hyphens",
            ));
        }
        for label in strings(config.get("labels")) {
            if !ValueFormat::Label.is_valid(&label) {
                issues.push(FieldIssue::for_field(
                    "labels",
                    format!(
                        "'{label}' must be at most 50 characters without commas or line breaks"
                    ),
                ));
            }
        }
        Ok(issues)
    }

    fn check_connection(&self, config: &ConfigValues) -> Result<ConnectionCheck, SourceError> {
        let response = self.get(
            &format!("{}/user", self.api_url),
            "the signed-in GitHub user",
        )?;
        let user = response_json(&response)?;
        let tracker_time = response
            .header("date")
            .and_then(|value| chrono::DateTime::parse_from_rfc2822(value).ok())
            .map(|time| {
                time.to_utc()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            });
        let account = user
            .get("login")
            .and_then(Value::as_str)
            .ok_or_else(|| SourceError::Protocol("the user has no login".into()))?;
        if config
            .get("account")
            .and_then(Value::as_str)
            .is_some_and(|expected| {
                !expected.trim().is_empty() && !expected.trim().eq_ignore_ascii_case(account)
            })
        {
            return Err(SourceError::Unauthenticated(
                "the GitHub credential belongs to a different account".into(),
            ));
        }
        Ok(ConnectionCheck {
            connection: ConnectionInfo {
                account: account.to_owned(),
                account_id: Some(format!(
                    "id:{}",
                    user_database_id(&user)
                        .ok_or_else(|| SourceError::Protocol("the user has no valid ID".into()))?
                )),
                site: self.site(),
                tracker_time,
                publication_requires_tracker_time: false,
            },
            derived: Self::derived_configuration(config, self.web_site.as_deref()),
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
                    let (page, next) = self.json(&current, "the list of your repositories")?;
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
                        class: error.class(),
                        message: match error {
                            SourceError::NotFound(_) => {
                                format!("{repository} was not found, or your account cannot see it")
                            }
                            other => other.to_string(),
                        },
                        field: Some("repositories".to_owned()),
                        partition: partition_name(self.web_site.as_deref(), repository),
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
            if let Some(issue) = translate_issue(self, item, repository)? {
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

    fn fetch(
        &self,
        _config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        Ok(self.read_issue(reference)?.issue)
    }

    fn fetch_tracked(
        &self,
        _config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<FetchedIssue, SourceError> {
        self.read_issue(reference)
    }

    fn conversation(
        &self,
        _config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<Conversation, SourceError> {
        self.check_issue_host(reference)?;
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

    fn repository_for_destination(&self, destination: &str) -> Option<String> {
        let host = site_host(self.web_site.as_deref()?);
        crate::project_remote::normalize_project_remote(&format!("{host}/{destination}"))
    }

    // GitHub does not tell `Owner/Name` from `owner/name`.
    fn same_destination(&self, a: &str, b: &str) -> bool {
        a.eq_ignore_ascii_case(b)
    }

    fn publication(&self) -> Option<&dyn Publication> {
        Some(self)
    }
}

impl Publication for GithubConnector {
    fn publish(
        &self,
        _config: &ConfigValues,
        request: &PublishRequest,
    ) -> Result<ExternalIssue, SourceError> {
        self.create_issue(&request.destination, request, None)
    }

    fn publish_before(
        &self,
        _config: &ConfigValues,
        request: &PublishRequest,
        deadline: std::time::Instant,
    ) -> Result<ExternalIssue, SourceError> {
        check_publication_deadline(Some(deadline))?;
        self.create_issue(&request.destination, request, Some(deadline))
    }

    fn locate(
        &self,
        _config: &ConfigValues,
        destination: &str,
        text: &str,
    ) -> Result<ExternalIssue, SourceError> {
        let number = issue_number_in(text, destination, self.web_site.as_deref())?;
        let url = format!(
            "{}/repos/{}/issues/{number}",
            self.api_url,
            encode_path(destination)
        );
        let (value, _) = self.json(&url, &format!("issue {destination}#{number}"))?;
        let issue = translate_issue(self, &value, destination)?.ok_or_else(|| {
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
        require_repository(destination)?;
        // Only the tracker clock observed before creation establishes a
        // lower bound. With no clock, read from the beginning of history
        // and rule out a remaining issue only when the destination is empty.
        let since = search
            .tracker_since
            .as_deref()
            .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok());
        let mut request = format!(
            "{}/repos/{}/issues?state=all&sort=created&direction=desc&per_page=100",
            self.api_url,
            encode_path(destination),
        );
        if let Some(since) = since {
            let since_text = since
                .to_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            request.push_str("&since=");
            request.push_str(&encode_component(&since_text));
        }
        let mut url = Some(request);
        let mut reliable = true;
        let subject = format!("repository {destination}");
        let mut matches = Vec::new();
        let mut recent = Vec::new();
        let account = search.account.as_deref();
        let account_id = account.and_then(account_database_id);
        for _ in 0..SEARCH_PAGES {
            let Some(current) = url.take() else {
                break;
            };
            let (page, next) = self.json(&current, &subject)?;
            let items = page
                .as_array()
                .ok_or_else(|| SourceError::Protocol("expected a list of issues".into()))?;
            for item in items {
                let Some(issue) = translate_issue(self, item, destination)? else {
                    continue;
                };
                // Newest first: the first issue older than the window ends the read.
                let created = chrono::DateTime::parse_from_rfc3339(&issue.created_at).ok();
                reliable &= since.is_some() && created.is_some();
                if let (Some(created), Some(since)) = (created, since)
                    && created < since
                {
                    return Ok(PublicationCandidates {
                        matches,
                        recent,
                        complete: reliable,
                    });
                }
                // An issue the connected account created in the window may have been
                // rewritten by a teammate or an automation, so it is also a
                // candidate and blocks "not created".
                let creator = item.get("user");
                let by_account = if let Some(account_id) = account_id {
                    let creator_id = creator.and_then(user_database_id);
                    reliable &= creator_id.is_some();
                    creator_id == Some(account_id)
                } else {
                    account.is_some_and(|account| {
                        creator
                            .and_then(|user| user.get("login"))
                            .and_then(Value::as_str)
                            .is_some_and(|login| login.eq_ignore_ascii_case(account))
                    })
                };
                if could_be_published(&issue, &search.request) {
                    matches.push(issue);
                } else if by_account {
                    recent.push(issue);
                }
            }
            url = next;
        }
        Ok(PublicationCandidates {
            matches,
            recent,
            complete: reliable && url.is_none(),
        })
    }
}

impl GithubConnector {
    /// Derived answers also keep older saved settings usable before the first
    /// successful connection check under the new contract.
    fn derived_configuration(config: &ConfigValues, host: Option<&str>) -> DerivedConfiguration {
        let destinations = Self::repositories(config);
        let partitions = destinations
            .iter()
            .map(|repository| partition_name(host, repository))
            .collect();
        // GitHub matches logins and label names without regard to case.
        let mut scope = Vec::new();
        if let Some(assignee) = config.get("assignee").and_then(Value::as_str) {
            scope.push(format!("assignee={}", assignee.to_lowercase()));
        }
        let mut labels: Vec<String> = strings(config.get("labels"))
            .iter()
            .map(|label| label.to_lowercase())
            .collect();
        labels.sort();
        labels.dedup();
        if !labels.is_empty() {
            scope.push(format!("labels={}", labels.join(",")));
        }
        DerivedConfiguration {
            partitions,
            discovery_scope: scope.join("&"),
            publication: DestinationRules {
                destinations,
                case_insensitive: true,
                validation: Some(DestinationValidation {
                    format: ValueFormat::OwnerName,
                    message: DESTINATION_FORMAT_MESSAGE.into(),
                }),
                ..DestinationRules::default()
            },
        }
    }

    fn read_issue(&self, reference: &ExternalRef) -> Result<FetchedIssue, SourceError> {
        self.check_issue_host(reference)?;
        let (repository, number) = split_locator(&reference.locator)?;
        let url = format!(
            "{}/repos/{}/issues/{number}",
            self.api_url,
            encode_path(repository)
        );
        let (response, target) = self.send(
            Method::Get,
            &url,
            None,
            &format!("issue {}", reference.locator),
        )?;
        let value: Value = serde_json::from_slice(&response.body)
            .map_err(|_| SourceError::Protocol("GitHub returned a body that is not JSON".into()))?;
        let mut issue = translate_issue(self, &value, repository)?.ok_or_else(|| {
            SourceError::NotFound(format!(
                "{} is a pull request, not an issue",
                reference.locator
            ))
        })?;
        // A GitHub transfer can allocate a different REST ID. Require the old
        // issue path to redirect permanently to the exact new issue path, and
        // corroborate it with the destination's API and web links.
        let transferred_from = target
            .filter(|target| {
                let Ok((destination, number)) = split_locator(&issue.reference.locator) else {
                    return false;
                };
                let api_repository = target.strip_suffix(&format!("/issues/{number}"));
                issue.reference.identity != reference.identity
                    && !repository.eq_ignore_ascii_case(destination)
                    && value
                        .get("id")
                        .and_then(Value::as_u64)
                        .is_some_and(|id| id > 0)
                    && value.get("url").and_then(Value::as_str) == Some(target.as_str())
                    && api_repository.is_some()
                    && value.get("repository_url").and_then(Value::as_str) == api_repository
                    && self.issue_api_locator(target).is_some_and(|locator| {
                        locator.eq_ignore_ascii_case(&issue.reference.locator)
                    })
                    && issue_site_from_url(&issue.reference.locator, &issue.url).as_deref()
                        == self.web_site.as_deref()
            })
            .map(|_| reference.clone());
        if issue.state.category == StateCategory::Duplicate {
            let id = value
                .get("id")
                .and_then(Value::as_u64)
                .ok_or_else(|| SourceError::Protocol("an issue had no id".into()))?;
            let (observed_repository, observed_number) = split_locator(&issue.reference.locator)?;
            match self.canonical_of(observed_repository, observed_number, id) {
                Canonical::Named { reference, url } => {
                    issue.duplicate_of = Some(reference);
                    issue.duplicate_of_url = url;
                }
                Canonical::Withdrawn => issue.duplicate_withdrawn = true,
                Canonical::NotSupplied => {}
            }
        }
        Ok(FetchedIssue {
            issue,
            transferred_from,
        })
    }

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
    SourceError::InvalidConfiguration(vec![super::schema::FieldIssue::for_field(
        "issue",
        format!("is not in {destination}"),
    )])
}

/// The issue number in `text`, which may be `12`, `#12`, `owner/name#12` or an
/// issue link on the current host, provided it names `destination` (compared without case).
fn issue_number_in(text: &str, destination: &str, host: Option<&str>) -> Result<u64, SourceError> {
    let text = text.trim();
    let invalid = || {
        SourceError::InvalidConfiguration(vec![super::schema::FieldIssue::for_field(
            "issue",
            "must be an issue number, owner/name#number or an issue link",
        )])
    };
    let (repository, number) = if let Some(rest) = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"))
    {
        let (authority, path) = rest.split_once('/').ok_or_else(invalid)?;
        if authority.is_empty()
            || authority.contains('@')
            || text.contains(|c: char| c.is_whitespace() || c.is_control() || c == '\\')
        {
            return Err(invalid());
        }
        let url = url::Url::parse(text).map_err(|_| invalid())?;
        if web_site(&url).as_deref() != host {
            return Err(SourceError::InvalidConfiguration(vec![
                FieldIssue::for_field("issue", "use an issue link on the current GitHub host"),
            ]));
        }
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

pub(super) fn legacy_state_name(provider: &str, state: &str) -> Option<&'static str> {
    match (provider, state) {
        (PROVIDER, "open") => Some("Open"),
        (PROVIDER, "closed") => Some("Closed"),
        _ => None,
    }
}

pub(super) fn legacy_reference_partition(
    provider: &str,
    id: &str,
    locator: &str,
) -> Option<String> {
    (provider == PROVIDER).then(|| {
        let repository = locator.rsplit_once('#').map_or(locator, |(part, _)| part);
        partition_name(issue_id_site(id), repository)
    })
}

fn configured_api_url() -> Option<String> {
    std::env::var(API_URL_VARIABLE)
        .ok()
        .map(|url| url.trim().trim_end_matches('/').to_owned())
        .filter(|url| !url.is_empty())
}

fn web_site(url: &url::Url) -> Option<String> {
    let host = web_host_for_api(url.host_str()?);
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

fn site_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .as_ref()
        .and_then(web_site)
        .filter(|site| site != "github.com")
        .unwrap_or_default()
}

/// Historical GitHub IDs are numbers, so known different hosts cannot share one.
pub(crate) fn legacy_issue_origin_matches(provider: &str, stored: &str, incoming: &str) -> bool {
    if provider != PROVIDER || stored == incoming {
        return true;
    }
    let site = |text: &str| {
        let url = url::Url::parse(text).ok()?;
        (matches!(url.scheme(), "https" | "http") && url.has_host()).then(|| site_of(url.as_str()))
    };
    match (site(stored), site(incoming)) {
        (Some(stored), Some(incoming)) => stored == incoming,
        (Some(_), None) => false,
        (None, _) => true,
    }
}

pub(super) fn legacy_site(issue_urls: &[String]) -> String {
    // Prior settings did not store the API host. An explicit API gateway can
    // differ from the hostname in a tracker’s human-readable issue links.
    if let Some(api) = configured_api_url().filter(|api| credential_may_travel(api)) {
        return site_of(&api);
    }
    let mut sites = issue_urls.iter().filter_map(|text| {
        let url = url::Url::parse(text).ok()?;
        (matches!(url.scheme(), "https" | "http") && url.has_host()).then(|| site_of(url.as_str()))
    });
    if let Some(site) = sites.next()
        && sites.all(|observed| observed == site)
    {
        return site;
    }
    String::new()
}

pub(super) fn legacy_derived_configuration(
    provider: &str,
    site: &str,
    config: &ConfigValues,
) -> Option<DerivedConfiguration> {
    (provider == PROVIDER).then(|| {
        let host = if site.is_empty() { "github.com" } else { site };
        GithubConnector::derived_configuration(config, Some(host))
    })
}

const DESTINATION_FORMAT_MESSAGE: &str = "must be a repository in the form owner/name";

/// A destination must be a repository in the form `owner/name`.
fn require_repository(destination: &str) -> Result<(), SourceError> {
    if ValueFormat::OwnerName.is_valid(destination) {
        return Ok(());
    }
    Err(SourceError::InvalidConfiguration(vec![
        FieldIssue::for_field("destination", DESTINATION_FORMAT_MESSAGE),
    ]))
}

/// The headers of every authenticated request, with a JSON body when `json_body`.
fn request_headers(token: &credentials::Secret, json_body: bool) -> Vec<(String, String)> {
    let mut headers = vec![
        (
            "Accept".to_owned(),
            "application/vnd.github+json".to_owned(),
        ),
        ("X-GitHub-Api-Version".to_owned(), "2022-11-28".to_owned()),
        ("User-Agent".to_owned(), "ticketd".to_owned()),
        (
            "Authorization".to_owned(),
            format!("Bearer {}", token.expose()),
        ),
    ];
    if json_body {
        headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
    }
    headers
}

/// The host part of an API address.
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or("");
    authority
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        .map_or(authority, |(host, _)| host)
        .to_owned()
}

/// A token is sent only over https, or to this machine.
fn credential_may_travel(api_url: &str) -> bool {
    if api_url.starts_with("https://") {
        return true;
    }
    api_url.starts_with("http://")
        && matches!(
            host_of(api_url).as_str(),
            "localhost" | "127.0.0.1" | "[::1]"
        )
}

pub(super) fn split_locator(locator: &str) -> Result<(&str, &str), SourceError> {
    locator
        .rsplit_once('#')
        .filter(|(repository, number)| {
            ValueFormat::OwnerName.is_valid(repository)
                && !number.is_empty()
                && number.chars().all(|c| c.is_ascii_digit())
        })
        .ok_or_else(|| SourceError::Protocol("the issue locator is not valid".into()))
}

/// GitHub.com and data residency have dedicated API hostnames. Enterprise
/// Server can use any hostname, including one that starts with `api.`.
pub(super) fn web_host_for_api(host: &str) -> &str {
    if host == "api.github.com" {
        return "github.com";
    }
    host.strip_prefix("api.")
        .filter(|web| {
            web.strip_suffix(".ghe.com")
                .is_some_and(|tenant| !tenant.is_empty() && !tenant.contains('.'))
        })
        .unwrap_or(host)
}

fn issue_id(id: &str, host: &str) -> String {
    if host == "github.com" {
        id.to_owned()
    } else {
        format!("@{host}:{id}")
    }
}

pub(super) fn partition_name(host: Option<&str>, repository: &str) -> String {
    let repository = repository.to_lowercase();
    match host {
        // Keep the bare keys that public GitHub workspaces have already saved.
        Some("github.com") => repository,
        _ => format!("@{}/{repository}", host.unwrap_or_default()),
    }
}

pub(crate) fn issue_id_host(id: &str) -> Option<&str> {
    issue_id_site(id).map(site_host)
}

pub(crate) fn issue_id_site(id: &str) -> Option<&str> {
    if id.parse::<u64>().is_ok() {
        return Some("github.com");
    }
    let (host, number) = id.strip_prefix('@')?.rsplit_once(':')?;
    (!host.is_empty() && number.parse::<u64>().is_ok()).then_some(host)
}

pub(super) fn site_host(site: &str) -> &str {
    site.rsplit_once(':')
        .filter(|(_, port)| port.parse::<u16>().is_ok())
        .map_or(site, |(host, _)| host)
}

/// Older Enterprise issues qualified the ID with the hostname only. An exact
/// saved issue URL can supply their nondefault port.
pub(super) fn scope_host_only_issue_id(id: &str, site: &str) -> Option<String> {
    let stored = issue_id_site(id)?;
    let number = id.rsplit_once(':').map_or(id, |(_, number)| number);
    (site != stored && site_host(site) == stored).then(|| issue_id(number, site))
}

pub(crate) fn issue_site_from_url(locator: &str, url: &str) -> Option<String> {
    repository_from_issue_url(locator, url)?;
    web_site(&url::Url::parse(url).ok()?)
}

/// Legacy GitHub IDs were numeric for every host. Keep unverified IDs away from
/// public GitHub's numeric range as well, without guessing where they came from.
pub(super) fn scope_legacy_issue_id(id: &str, host: Option<&str>) -> Option<String> {
    id.parse::<u64>().ok()?;
    Some(issue_id(id, host.unwrap_or_default()))
}

pub(crate) fn unverified_issue_id(id: &str) -> Option<&str> {
    let database_id = id.strip_prefix("@:")?;
    database_id.parse::<u64>().ok()?;
    Some(database_id)
}

/// Recover a legacy issue's host only when the saved web URL corroborates its locator.
pub(super) fn repository_from_issue_url(locator: &str, issue_url: &str) -> Option<String> {
    let (url_locator, repository) = issue_location_from_url(issue_url)?;
    url_locator
        .eq_ignore_ascii_case(locator)
        .then_some(repository)
}

/// Parse a full issue URL as its issue locator and hosted repository.
pub(super) fn issue_location_from_url(issue_url: &str) -> Option<(String, String)> {
    if issue_url.contains(|c: char| c.is_whitespace() || c.is_control() || c == '\\') {
        return None;
    }
    let url = url::Url::parse(issue_url).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    // Check the literal path because the URL parser collapses dot segments.
    let (authority, path) = issue_url.split_once("://")?.1.split_once('/')?;
    let (url_repository, url_number) = path.rsplit_once("/issues/")?;
    if authority.is_empty()
        || authority.contains('@')
        || !ValueFormat::OwnerName.is_valid(url_repository)
        || !url_number.bytes().all(|digit| digit.is_ascii_digit())
        || url_number.parse::<u64>().ok()? == 0
    {
        return None;
    }
    let repository = crate::project_remote::normalize_project_remote(&format!(
        "{}/{url_repository}",
        web_host_for_api(url.host_str()?)
    ))?;
    Some((format!("{url_repository}#{url_number}"), repository))
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
        Some("closed") => ExternalEventKind::Closed(StateCategory::from_closure(
            item.get("state_reason").and_then(Value::as_str),
        )),
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
timelineItems(last: 50, itemTypes: [CLOSED_EVENT, MARKED_AS_DUPLICATE_EVENT, UNMARKED_AS_DUPLICATE_EVENT]) { nodes { \
__typename \
... on ClosedEvent { stateReason duplicateOf { __typename ... on Issue { databaseId number url repository { nameWithOwner } } } } \
... on MarkedAsDuplicateEvent { duplicate { ... on Issue { databaseId } } \
canonical { __typename ... on Issue { databaseId number url repository { nameWithOwner } } } } \
... on UnmarkedAsDuplicateEvent { duplicate { ... on Issue { databaseId } } } } } } } }";

/// An issue named as canonical, or `None` for anything ticketd cannot track
/// (a pull request, or a target the credential cannot read).
fn canonical_reference(
    connector: &GithubConnector,
    canonical: &Value,
) -> Option<(ExternalRef, Option<String>)> {
    if canonical.get("__typename").and_then(Value::as_str) != Some("Issue") {
        return None;
    }
    let id = canonical.get("databaseId").and_then(Value::as_u64)?;
    let number = canonical.get("number").and_then(Value::as_u64)?;
    let repository = canonical.pointer("/repository/nameWithOwner")?.as_str()?;
    let url = canonical
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some((
        ExternalRef {
            identity: connector.issue_identity(id).ok()?,
            locator: format!("{repository}#{number}"),
            partition: partition_name(connector.web_site.as_deref(), repository),
        },
        url,
    ))
}

/// What the timeline says about a duplicate's canonical issue.
enum Canonical {
    Named {
        reference: ExternalRef,
        url: Option<String>,
    },
    /// The marking was withdrawn.
    Withdrawn,
    /// Nothing usable came back (no access, an error, a pull request).
    NotSupplied,
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

/// The shared half of the guidance: each surface adds its own with
/// [`SourceError::message_for`].
fn missing_credential() -> SourceError {
    SourceError::Unauthenticated(
        "no GitHub credential found. Run `gh auth login` to sign in.".into(),
    )
}

fn classify(response: HttpResponse, subject: &str) -> Result<HttpResponse, SourceError> {
    let status = response.status;
    if (200..300).contains(&status) {
        return Ok(response);
    }
    let message = response_message(&response);
    let error = match status {
        401 => SourceError::Unauthenticated(
            "GitHub rejected the credential. Run `gh auth login` to sign in again.".into(),
        ),
        403 | 429 => {
            let limited = status == 429
                || response.header("x-ratelimit-remaining") == Some("0")
                || response.header("retry-after").is_some()
                || message
                    .as_deref()
                    .is_some_and(|m| m.to_lowercase().contains("rate limit"));
            if limited {
                SourceError::RateLimited {
                    retry_after_secs: retry_after(&response),
                }
            } else {
                SourceError::Forbidden(format!(
                    "GitHub denied access to {subject}; the credential needs permission to read issues there"
                ))
            }
        }
        // A deleted issue, or a repository with issues disabled.
        404 | 410 => SourceError::NotFound(format!(
            "{subject} was not found, or the credential cannot see it"
        )),
        500..=599 => SourceError::Unavailable(format!(
            "GitHub is unavailable (status {status}); retry later"
        )),
        _ => SourceError::Protocol(format!("GitHub answered {subject} with status {status}")),
    };
    // An arbitrary response message can echo credentials or submitted content.
    Err(error.with_detail(format_args!("HTTP {status}")))
}

fn user_database_id(user: &Value) -> Option<u64> {
    user.get("id").and_then(Value::as_u64).filter(|id| *id != 0)
}

pub(super) fn account_database_id(key: &str) -> Option<u64> {
    key.strip_prefix("id:")?
        .parse::<u64>()
        .ok()
        .filter(|id| *id != 0)
}

fn response_json(response: &HttpResponse) -> Result<Value, SourceError> {
    serde_json::from_slice(&response.body)
        .map_err(|_| SourceError::Protocol("GitHub returned a body that is not JSON".into()))
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
    connector: &GithubConnector,
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
        Some("open") => ExternalState::named(StateCategory::Open, "Open"),
        Some("closed") => {
            ExternalState::named(StateCategory::from_closure(text("state_reason")), "Closed")
        }
        _ => return Err(missing("recognized state")),
    };
    let repository = text("repository_url")
        .and_then(|url| url.split_once("/repos/").map(|(_, name)| name))
        .unwrap_or(requested_repository);
    let display = format!("{repository}#{number}");
    Ok(Some(ExternalIssue {
        reference: ExternalRef {
            identity: connector.issue_identity(id)?,
            locator: display.clone(),
            partition: partition_name(connector.web_site.as_deref(), repository),
        },
        display,
        url: text("html_url").unwrap_or_default().to_owned(),
        repository: connector.repository_for_destination(repository),
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
        // GitHub reports an issue opened by a deleted account with no user.
        author: Some(
            item.get("user")
                .and_then(|user| user.get("login"))
                .and_then(Value::as_str)
                .unwrap_or("ghost")
                .to_owned(),
        ),
        // The issue payload does not name the canonical issue; `fetch` looks it up.
        duplicate_of: None,
        duplicate_of_url: None,
        duplicate_withdrawn: false,
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
