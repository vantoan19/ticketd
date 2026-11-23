//! An in-memory ticket source controlled by the workflow tests and conformance
//! driver. Hooks run outside the mutex so tests can interleave Workspace writes.
// Some controls are specific to one of the integration test targets.
#![allow(dead_code, clippy::unwrap_used)]

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use super::ticketd_core::source::{
    CONTRACT_VERSION, Capability, ChoiceOption, ConfigSchema, ConfigValues, ConnectionInfo,
    Connector, ConnectorDescriptor, Conversation, DiscoveryPage, DiscoveryRequest,
    ExternalIdentity, ExternalIssue, ExternalRef, ExternalState, FieldIssue, FieldKind,
    OptionSource, PublicationCandidates, PublicationSearch, PublishRequest, SchemaField,
    SkippedPartition, SourceError, SourcePresentation, ValueFormat,
};

pub type Hook = Arc<dyn Fn() + Send + Sync>;

#[derive(Default, Clone, Copy)]
pub enum PublishMode {
    #[default]
    Create,
    Refuse,
    NotSent,
    LoseResponse,
    Crash,
}

pub enum Failure {
    Unavailable,
    UnavailableWith(String),
    Forbidden,
    RateLimited(Option<u64>),
}

impl Failure {
    fn error(&self) -> SourceError {
        match self {
            Self::Unavailable => SourceError::Unavailable("network is down".into()),
            Self::UnavailableWith(message) => SourceError::Unavailable(message.clone()),
            Self::Forbidden => SourceError::Forbidden("access was revoked".into()),
            Self::RateLimited(retry_after_secs) => SourceError::RateLimited {
                retry_after_secs: *retry_after_secs,
            },
        }
    }
}

#[derive(Default)]
pub struct Remote {
    pub issues: BTreeMap<u64, ExternalIssue>,
    /// Discovery lists these issue IDs if they are open and pass the filters.
    pub matching: Vec<u64>,
    pub matching_by_repository: BTreeMap<String, Vec<u64>>,
    pub inaccessible: Vec<String>,
    pub page_size: Option<usize>,
    /// Explicit discovery pages override listing from the issue store. The
    /// cursor is the zero-based page index when these are set.
    pub pages: Vec<Result<DiscoveryPage, String>>,
    pub outage: Option<Failure>,
    pub connection_error: Option<String>,
    pub version: Option<u32>,
    pub display_name: Option<String>,
    pub presentation: SourcePresentation,
    pub repositories_optional: bool,
    pub discover_calls: usize,
    pub cursors_seen: Vec<Option<String>>,
    pub fetch_calls: Vec<u64>,
    pub deleted: Vec<u64>,
    pub broken: Vec<u64>,
    pub before_discovery: Option<Hook>,
    pub after_discovery: Option<Hook>,
    pub conversations: BTreeMap<u64, Conversation>,
    pub conversation_outage: Option<String>,
    pub conversation_calls: Vec<u64>,
    pub revision: u32,
    pub publish_mode: PublishMode,
    pub created: Vec<PublishRequest>,
    pub after_publish: Option<Hook>,
    pub lookup_down: bool,
    pub search_incomplete: bool,
    pub after_lookup: Option<Hook>,
}

#[derive(Clone, Default)]
pub struct FakeSource(pub Arc<Mutex<Remote>>);

impl FakeSource {
    fn lookup<T>(
        &self,
        compute: impl FnOnce(&Remote) -> Result<T, SourceError>,
    ) -> Result<T, SourceError> {
        let (result, hook) = {
            let mut remote = self.0.lock().unwrap();
            if remote.lookup_down {
                return Err(SourceError::Unavailable("provider unreachable".into()));
            }
            (compute(&remote), remote.after_lookup.take())
        };
        if let Some(hook) = hook {
            hook();
        }
        result
    }
}

impl Connector for FakeSource {
    fn descriptor(&self) -> ConnectorDescriptor {
        let remote = self.0.lock().unwrap();
        ConnectorDescriptor {
            provider: "fake".into(),
            name: remote.display_name.clone().unwrap_or_else(|| "Fake".into()),
            contract_version: remote.version.unwrap_or(CONTRACT_VERSION),
            capabilities: vec![
                Capability::Discover,
                Capability::Fetch,
                Capability::Comments,
                Capability::Publish,
            ],
            schema: ConfigSchema {
                fields: vec![
                    multi_select(
                        "repositories",
                        "Repositories",
                        Some(ValueFormat::OwnerName),
                        !remote.repositories_optional,
                    ),
                    SchemaField {
                        key: "assignee".into(),
                        label: "Assignee".into(),
                        help: None,
                        required: false,
                        kind: FieldKind::Text {
                            placeholder: None,
                            format: Some(ValueFormat::Handle),
                        },
                    },
                    multi_select("labels", "Labels", None, false),
                ],
            },
        }
    }

    fn presentation(&self) -> SourcePresentation {
        self.0.lock().unwrap().presentation.clone()
    }

    fn check_connection(&self, _: &ConfigValues) -> Result<ConnectionInfo, SourceError> {
        match self.0.lock().unwrap().connection_error.clone() {
            Some(message) => Err(SourceError::Unauthenticated(message)),
            None => Ok(ConnectionInfo {
                account: "octo".into(),
            }),
        }
    }

    fn options(
        &self,
        _: &str,
        query: &str,
        _: &ConfigValues,
    ) -> Result<Vec<ChoiceOption>, SourceError> {
        Ok(vec![ChoiceOption {
            value: format!("o/{query}"),
            label: format!("o/{query}"),
            description: None,
        }])
    }

    fn discover(&self, request: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError> {
        let hook = self.0.lock().unwrap().before_discovery.take();
        if let Some(hook) = hook {
            hook();
        }
        let mut remote = self.0.lock().unwrap();
        remote.discover_calls += 1;
        remote.cursors_seen.push(request.cursor.map(str::to_owned));
        if let Some(failure) = &remote.outage {
            return Err(failure.error());
        }
        let start = request
            .cursor
            .map_or(Ok(0), str::parse::<usize>)
            .map_err(|_| SourceError::Protocol("unrecognized discovery cursor".into()))?;
        let page = if remote.pages.is_empty() {
            issue_page(&remote, request, start)
        } else {
            remote.pages.get(start).map_or_else(
                || Ok(discovery_page(Vec::new(), None)),
                |page| page.clone().map_err(SourceError::Unavailable),
            )?
        };
        let hook = remote.after_discovery.take();
        drop(remote);
        if let Some(hook) = hook {
            hook();
        }
        Ok(page)
    }

    fn partition(&self, reference: &ExternalRef) -> String {
        repository_of(reference).into()
    }

    fn partitions(&self, config: &ConfigValues) -> Vec<String> {
        strings(config, "repositories")
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    fn discovery_scope(&self, config: &ConfigValues) -> String {
        strings(config, "labels").join(",")
    }

    fn fetch(
        &self,
        _: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        let mut remote = self.0.lock().unwrap();
        let id = issue_id(reference)?;
        remote.fetch_calls.push(id);
        if let Some(failure) = &remote.outage {
            return Err(failure.error());
        }
        if remote.broken.contains(&id) {
            return Err(SourceError::Protocol("answered with status 500".into()));
        }
        if remote.deleted.contains(&id) {
            return Err(SourceError::NotFound("the issue was deleted".into()));
        }
        remote
            .issues
            .get(&id)
            .cloned()
            .ok_or_else(|| SourceError::NotFound("gone".into()))
    }

    fn conversation(
        &self,
        _: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<Conversation, SourceError> {
        let mut remote = self.0.lock().unwrap();
        let id = issue_id(reference)?;
        remote.conversation_calls.push(id);
        if let Some(message) = remote.conversation_outage.clone() {
            return Err(SourceError::Unavailable(message));
        }
        Ok(remote.conversations.get(&id).cloned().unwrap_or_default())
    }

    fn destinations(&self, config: &ConfigValues) -> Vec<String> {
        self.partitions(config)
    }

    fn check_destination(&self, destination: &str) -> Result<(), SourceError> {
        match destination.split_once('/') {
            Some((owner, name)) if !owner.is_empty() && !name.is_empty() && !name.contains('/') => {
                Ok(())
            }
            _ => Err(configuration_error(
                "destination",
                "must be a repository in the form owner/name".into(),
            )),
        }
    }

    fn same_destination(&self, a: &str, b: &str) -> bool {
        a.eq_ignore_ascii_case(b)
    }

    // A panic simulates the process dying after the provider created its issue.
    #[allow(clippy::panic)]
    fn publish(
        &self,
        _: &ConfigValues,
        request: &PublishRequest,
    ) -> Result<ExternalIssue, SourceError> {
        self.check_destination(&request.destination)?;
        let (issue, mode, hook) = {
            let mut remote = self.0.lock().unwrap();
            match remote.publish_mode {
                PublishMode::NotSent => {
                    return Err(SourceError::NotSent("could not reach the provider".into()));
                }
                PublishMode::Refuse => {
                    return Err(SourceError::Forbidden(
                        "no permission to create issues".into(),
                    ));
                }
                _ => {}
            }
            remote.created.push(request.clone());
            let id = 100 + remote.created.len() as u64;
            let mut issue = issue_in(&request.destination, id, &request.title);
            issue.body.clone_from(&request.body);
            issue.author = Some("octo".into());
            issue.created_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            issue.updated_at.clone_from(&issue.created_at);
            remote.issues.insert(id, issue.clone());
            remote.matching.push(id);
            (issue, remote.publish_mode, remote.after_publish.clone())
        };
        if let Some(hook) = hook {
            hook();
        }
        match mode {
            PublishMode::LoseResponse => Err(SourceError::Unavailable(
                "GitHub is unavailable (status 502); retry later".into(),
            )),
            PublishMode::Crash => panic!("process died during the create call"),
            _ => Ok(issue),
        }
    }

    fn locate(
        &self,
        _: &ConfigValues,
        destination: &str,
        text: &str,
    ) -> Result<ExternalIssue, SourceError> {
        self.lookup(|remote| {
            let (repository, number) = text.rsplit_once('#').unwrap_or((destination, text));
            let not_in_destination =
                || configuration_error("issue", format!("is not in {destination}"));
            if !self.same_destination(repository, destination) {
                return Err(not_in_destination());
            }
            let id = number
                .parse()
                .map_err(|_| SourceError::NotFound("not an issue".into()))?;
            let issue = remote
                .issues
                .get(&id)
                .cloned()
                .ok_or_else(|| SourceError::NotFound("no such issue".into()))?;
            if !self.same_destination(repository_of(&issue.reference), destination) {
                return Err(not_in_destination());
            }
            Ok(issue)
        })
    }

    fn find_published(
        &self,
        _: &ConfigValues,
        search: &PublicationSearch,
    ) -> Result<PublicationCandidates, SourceError> {
        self.lookup(|remote| {
            let mut matches = Vec::new();
            let mut recent = Vec::new();
            let since = chrono::DateTime::parse_from_rfc3339(&search.since).unwrap();
            for issue in remote.issues.values() {
                if !self
                    .same_destination(repository_of(&issue.reference), &search.request.destination)
                    || chrono::DateTime::parse_from_rfc3339(&issue.created_at).unwrap() < since
                {
                    continue;
                }
                if issue.title == search.request.title
                    || (!search.request.body.is_empty() && issue.body == search.request.body)
                {
                    matches.push(issue.clone());
                } else if search.account.is_some() && issue.author == search.account {
                    recent.push(issue.clone());
                }
            }
            Ok(PublicationCandidates {
                matches,
                recent,
                complete: !remote.search_incomplete,
            })
        })
    }
}

fn multi_select(
    key: &str,
    label: &str,
    format: Option<ValueFormat>,
    required: bool,
) -> SchemaField {
    SchemaField {
        key: key.into(),
        label: label.into(),
        help: None,
        required,
        kind: FieldKind::MultiSelect {
            options: OptionSource::Dynamic { depends_on: vec![] },
            allow_custom: true,
            min_items: usize::from(required),
            max_items: 3,
            format,
        },
    }
}

fn configuration_error(field: &str, message: String) -> SourceError {
    SourceError::InvalidConfiguration(vec![FieldIssue {
        field: field.into(),
        message,
    }])
}

fn issue_id(reference: &ExternalRef) -> Result<u64, SourceError> {
    reference
        .identity
        .id
        .parse()
        .map_err(|_| SourceError::NotFound("not an issue".into()))
}

fn strings<'a>(config: &'a ConfigValues, key: &str) -> Vec<&'a str> {
    config
        .get(key)
        .and_then(|items| items.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str())
        .collect()
}

fn repository_of(reference: &ExternalRef) -> &str {
    reference.locator.split('#').next().unwrap()
}

fn issue_page(remote: &Remote, request: DiscoveryRequest<'_>, start: usize) -> DiscoveryPage {
    let repositories = strings(request.config, "repositories");
    let matching = repositories
        .first()
        .and_then(|repository| remote.matching_by_repository.get(*repository))
        .unwrap_or(&remote.matching);
    let labels = strings(request.config, "labels");
    let issues: Vec<_> = matching
        .iter()
        .filter_map(|id| remote.issues.get(id))
        .filter(|issue| issue.state == ExternalState::Open)
        .filter(|issue| {
            labels
                .iter()
                .all(|label| issue.labels.iter().any(|actual| actual == label))
        })
        .filter(|issue| {
            !remote
                .inaccessible
                .iter()
                .any(|part| part == repository_of(&issue.reference))
        })
        .cloned()
        .collect();
    let start = start.min(issues.len());
    let size = remote.page_size.unwrap_or(request.page_size).max(1);
    let end = start.saturating_add(size).min(issues.len());
    let mut page = discovery_page(
        issues[start..end].to_vec(),
        (end < issues.len()).then(|| end.to_string()),
    );
    if request.cursor.is_none() {
        page.skipped = remote
            .inaccessible
            .iter()
            .map(|partition| SkippedPartition {
                code: "not_found".into(),
                message: format!("{partition} was not found"),
                field: None,
                partition: partition.clone(),
            })
            .collect();
    }
    page
}

pub fn discovery_page(issues: Vec<ExternalIssue>, next_cursor: Option<String>) -> DiscoveryPage {
    DiscoveryPage {
        issues,
        next_cursor,
        skipped: Vec::new(),
    }
}

pub fn issue(id: u64, title: &str) -> ExternalIssue {
    issue_in("o/r", id, title)
}

pub fn issue_in(repository: &str, id: u64, title: &str) -> ExternalIssue {
    ExternalIssue {
        reference: ExternalRef {
            identity: ExternalIdentity {
                provider: "fake".into(),
                id: id.to_string(),
            },
            locator: format!("{repository}#{id}"),
        },
        display: format!("{repository}#{id}"),
        url: format!("https://example.test/{repository}/issues/{id}"),
        title: title.into(),
        body: format!("Body of {title}"),
        state: ExternalState::Open,
        assignees: Vec::new(),
        labels: Vec::new(),
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-02-01T00:00:00Z".into(),
        author: Some("alice".into()),
        duplicate_of: None,
        duplicate_of_url: None,
        duplicate_withdrawn: false,
    }
}
