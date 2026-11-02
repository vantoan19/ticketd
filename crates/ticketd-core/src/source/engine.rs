//! The ticketd-owned engine that runs connectors.
//!
//! The engine validates configuration against each connector's schema, drives
//! paging, enforces bounds, and de-duplicates by external identity. It is the
//! only caller of [`Connector`] methods and holds no database handle: workflows
//! on [`crate::Workspace`] fetch through the engine first and then apply the
//! result in a short transaction.

use std::{collections::HashSet, ops::ControlFlow};

use serde::{Deserialize, Serialize};

use super::{
    contract::{
        CONTRACT_VERSION, Capability, ConnectionInfo, Connector, ConnectorDescriptor, Conversation,
        DiscoveryRequest, ExternalIssue, ExternalRef, ExternalState, PublicationCandidates,
        PublicationSearch, PublishRequest, SkippedPartition, SourceError,
    },
    github::GithubConnector,
    schema::{ChoiceOption, ConfigValues, FieldKind, OptionSource},
};

/// Issues requested per provider call.
const PAGE_SIZE: usize = 100;
/// A connector that keeps returning continuations is stopped after this many pages.
const MAX_PAGES: usize = 200;
/// Issues a preview examines before it stops counting.
const PREVIEW_SCAN_LIMIT: usize = 200;
/// Issues a preview lists.
const PREVIEW_LIST_LIMIT: usize = 25;
/// Most options returned for a selector.
const OPTION_LIMIT: usize = 50;

/// An issue as listed in a preview. It carries no description, so a preview
/// never renders more of the external record than it needs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewIssue {
    pub display: String,
    pub url: String,
    pub title: String,
    pub state: ExternalState,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub updated_at: String,
}

/// What discovery would find. Previewing imports nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryPreview {
    pub provider: String,
    pub account: String,
    /// The first matches, at most [`PREVIEW_LIST_LIMIT`].
    pub issues: Vec<PreviewIssue>,
    /// Matches counted so far.
    pub matched: usize,
    /// False when counting stopped at the scan limit, so more matches exist.
    pub complete: bool,
}

/// How a full discovery walk ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoverySummary {
    /// Distinct issues passed to the visitor.
    pub seen: usize,
    /// False when the visitor stopped the walk early.
    pub complete: bool,
    /// Parts of the discovery rules the connector skipped because they could not
    /// be read (a repository that is gone, for example).
    pub skipped: Vec<SkippedPartition>,
}

#[derive(Default)]
pub struct Engine {
    connectors: Vec<Box<dyn Connector>>,
}

impl Engine {
    /// An engine with no connectors.
    pub fn new() -> Self {
        Self::default()
    }

    /// An engine with every connector built into ticketd, using ambient
    /// credentials and the real network.
    pub fn builtin() -> Self {
        let mut engine = Self::new();
        // The built-in connector speaks the current contract by construction.
        let _ = engine.register(Box::new(GithubConnector::ambient()));
        engine
    }

    /// Adds a connector, refusing one that speaks another contract version or
    /// reuses a provider id.
    pub fn register(&mut self, connector: Box<dyn Connector>) -> Result<(), SourceError> {
        let descriptor = connector.descriptor();
        if descriptor.contract_version != CONTRACT_VERSION {
            return Err(SourceError::IncompatibleContract {
                provider: descriptor.provider,
                found: descriptor.contract_version,
            });
        }
        if self.find(&descriptor.provider).is_some() {
            return Err(SourceError::Protocol(format!(
                "source '{}' is registered twice",
                descriptor.provider
            )));
        }
        self.connectors.push(connector);
        Ok(())
    }

    pub fn connectors(&self) -> Vec<ConnectorDescriptor> {
        self.connectors.iter().map(|c| c.descriptor()).collect()
    }

    pub fn descriptor(&self, provider: &str) -> Result<ConnectorDescriptor, SourceError> {
        self.connector(provider).map(|c| c.descriptor())
    }

    /// Normalizes `raw` against the connector's schema.
    pub fn validate(
        &self,
        provider: &str,
        raw: &ConfigValues,
    ) -> Result<ConfigValues, SourceError> {
        let descriptor = self.descriptor(provider)?;
        descriptor
            .schema
            .validate(raw)
            .map_err(SourceError::InvalidConfiguration)
    }

    /// Verifies credentials and permissions for validated or unvalidated values.
    pub fn check_connection(
        &self,
        provider: &str,
        raw: &ConfigValues,
    ) -> Result<ConnectionInfo, SourceError> {
        let connector = self.connector(provider)?;
        // Connection setup is allowed before the discovery rules are complete.
        connector.check_connection(raw)
    }

    /// Dynamic options for a selector, narrowed by what the person typed.
    pub fn options(
        &self,
        provider: &str,
        field: &str,
        query: &str,
        raw: &ConfigValues,
    ) -> Result<Vec<ChoiceOption>, SourceError> {
        let connector = self.connector(provider)?;
        let descriptor = connector.descriptor();
        let known = descriptor.schema.field(field).map(|f| &f.kind);
        match known {
            Some(FieldKind::MultiSelect {
                options: OptionSource::Dynamic { .. },
                ..
            }) => {}
            _ => {
                return Err(SourceError::InvalidConfiguration(vec![
                    super::schema::FieldIssue {
                        field: field.to_owned(),
                        message: "does not offer dynamic options".into(),
                    },
                ]));
            }
        }
        let mut options = connector.options(field, query.trim(), raw)?;
        options.truncate(OPTION_LIMIT);
        Ok(options)
    }

    /// Walks every page of discovery results, passing each distinct issue to
    /// `visit` until it returns `Break`. This is the entry point import and
    /// refresh build on; it performs no persistence itself.
    pub fn discover(
        &self,
        provider: &str,
        raw: &ConfigValues,
        mut visit: impl FnMut(ExternalIssue) -> ControlFlow<()>,
    ) -> Result<DiscoverySummary, SourceError> {
        let connector = self.connector(provider)?;
        let descriptor = connector.descriptor();
        if !descriptor.capabilities.contains(&Capability::Discover) {
            return Err(SourceError::Unsupported("discovery"));
        }
        let config = self.validate(provider, raw)?;
        let mut seen_identities = HashSet::new();
        let mut seen_cursors = HashSet::new();
        let mut cursor: Option<String> = None;
        let mut seen = 0;
        let mut skipped = Vec::new();
        for _ in 0..MAX_PAGES {
            let page = connector.discover(DiscoveryRequest {
                config: &config,
                cursor: cursor.as_deref(),
                page_size: PAGE_SIZE,
            })?;
            skipped.extend(page.skipped);
            for issue in page.issues {
                if issue.reference.identity.provider != descriptor.provider {
                    return Err(SourceError::Protocol(
                        "an issue named a different provider".into(),
                    ));
                }
                if !seen_identities.insert(issue.reference.identity.clone()) {
                    continue;
                }
                seen += 1;
                if visit(issue).is_break() {
                    return Ok(DiscoverySummary {
                        seen,
                        complete: false,
                        skipped,
                    });
                }
            }
            match page.next_cursor {
                None => {
                    return Ok(DiscoverySummary {
                        seen,
                        complete: true,
                        skipped,
                    });
                }
                Some(next) => {
                    if !seen_cursors.insert(next.clone()) {
                        return Err(SourceError::Protocol("paging did not make progress".into()));
                    }
                    cursor = Some(next);
                }
            }
        }
        Err(SourceError::Protocol(
            "discovery returned too many pages".into(),
        ))
    }

    /// Reports what discovery would match, after confirming the connection.
    /// Nothing is imported or stored.
    pub fn preview(
        &self,
        provider: &str,
        raw: &ConfigValues,
    ) -> Result<DiscoveryPreview, SourceError> {
        let config = self.validate(provider, raw)?;
        let account = self.check_connection(provider, &config)?.account;
        let mut issues = Vec::new();
        let mut matched = 0;
        let summary = self.discover(provider, &config, |issue| {
            matched += 1;
            if issues.len() < PREVIEW_LIST_LIMIT {
                issues.push(PreviewIssue {
                    display: issue.display,
                    url: issue.url,
                    title: issue.title,
                    state: issue.state,
                    assignees: issue.assignees,
                    labels: issue.labels,
                    updated_at: issue.updated_at,
                });
            }
            if matched >= PREVIEW_SCAN_LIMIT {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        })?;
        // Saving rules that name a repository nobody can read is a mistake the
        // person should hear about now; a refresh tolerates it later.
        if let Some(part) = summary.skipped.first() {
            return Err(if part.code == "forbidden" {
                SourceError::Forbidden(part.message.clone())
            } else {
                SourceError::NotFound(part.message.clone())
            });
        }
        // Stopping exactly at the limit still proves nothing about what follows.
        let complete = summary.complete;
        Ok(DiscoveryPreview {
            provider: provider.to_owned(),
            account,
            issues,
            matched,
            complete,
        })
    }

    /// Re-reads one issue by reference.
    pub fn fetch(
        &self,
        provider: &str,
        raw: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        let connector = self.connector(provider)?;
        if !connector
            .descriptor()
            .capabilities
            .contains(&Capability::Fetch)
        {
            return Err(SourceError::Unsupported("fetching"));
        }
        let config = self.validate(provider, raw)?;
        let issue = connector.fetch(&config, reference)?;
        if issue.reference.identity != reference.identity {
            return Err(SourceError::Protocol(
                "the source returned a different issue than requested".into(),
            ));
        }
        Ok(issue)
    }

    /// Where `provider` can publish, for the saved configuration.
    pub fn publish_destinations(
        &self,
        provider: &str,
        raw: &ConfigValues,
    ) -> Result<Vec<String>, SourceError> {
        let connector = self.connector(provider)?;
        if !self.can_publish(provider) {
            return Ok(Vec::new());
        }
        let config = self.validate(provider, raw)?;
        Ok(connector.destinations(&config))
    }

    /// Whether `provider` declares the optional publication capability.
    pub fn can_publish(&self, provider: &str) -> bool {
        self.descriptor(provider)
            .is_ok_and(|d| d.capabilities.contains(&Capability::Publish))
    }

    /// Creates one issue. The caller must already have persisted the attempt:
    /// this performs the remote write, and whatever it returns, the issue may
    /// exist. A returned issue is checked to be an open issue of this provider.
    pub fn publish(
        &self,
        provider: &str,
        raw: &ConfigValues,
        request: &PublishRequest,
    ) -> Result<ExternalIssue, SourceError> {
        let connector = self.connector(provider)?;
        if !self.can_publish(provider) {
            return Err(SourceError::Unsupported("publishing"));
        }
        let config = self.validate(provider, raw)?;
        let issue = connector.publish(&config, request)?;
        if issue.reference.identity.provider != provider {
            return Err(SourceError::Protocol(
                "the created issue named a different provider".into(),
            ));
        }
        if issue.state != ExternalState::Open {
            return Err(SourceError::Protocol(
                "the created issue was not reported open".into(),
            ));
        }
        Ok(issue)
    }

    /// Reads the issue the person named for `destination`, checked to be an
    /// issue of this provider.
    pub fn locate(
        &self,
        provider: &str,
        raw: &ConfigValues,
        destination: &str,
        text: &str,
    ) -> Result<ExternalIssue, SourceError> {
        let connector = self.connector(provider)?;
        if !self.can_publish(provider) {
            return Err(SourceError::Unsupported("publishing"));
        }
        let config = self.validate(provider, raw)?;
        let issue = connector.locate(&config, destination, text)?;
        if issue.reference.identity.provider != provider {
            return Err(SourceError::Protocol(
                "the issue named a different provider".into(),
            ));
        }
        Ok(issue)
    }

    /// Looks for issues an uncertain publish may have created.
    pub fn find_published(
        &self,
        provider: &str,
        raw: &ConfigValues,
        search: &PublicationSearch,
    ) -> Result<PublicationCandidates, SourceError> {
        let connector = self.connector(provider)?;
        if !self.can_publish(provider) {
            return Err(SourceError::Unsupported("publishing"));
        }
        let config = self.validate(provider, raw)?;
        let found = connector.find_published(&config, search)?;
        if found
            .matches
            .iter()
            .any(|issue| issue.reference.identity.provider != provider)
        {
            return Err(SourceError::Protocol(
                "an issue named a different provider".into(),
            ));
        }
        Ok(found)
    }

    /// Reads an issue's conversation, sorted chronologically with comments
    /// before events that share a timestamp and repeated ids dropped. `None`
    /// when the connector does not declare [`Capability::Comments`].
    pub fn conversation(
        &self,
        provider: &str,
        raw: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<Option<Conversation>, SourceError> {
        let connector = self.connector(provider)?;
        if !connector
            .descriptor()
            .capabilities
            .contains(&Capability::Comments)
        {
            return Ok(None);
        }
        let config = self.validate(provider, raw)?;
        let mut conversation = connector.conversation(&config, reference)?;
        let mut comments = HashSet::new();
        conversation
            .comments
            .retain(|comment| comments.insert(comment.id.clone()));
        let mut events = HashSet::new();
        conversation
            .events
            .retain(|event| events.insert(event.id.clone()));
        conversation
            .comments
            .sort_by(|a, b| a.created_at.cmp(&b.created_at));
        conversation
            .events
            .sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(Some(conversation))
    }

    fn find(&self, provider: &str) -> Option<&dyn Connector> {
        self.connectors
            .iter()
            .find(|c| c.descriptor().provider == provider)
            .map(AsRef::as_ref)
    }

    fn connector(&self, provider: &str) -> Result<&dyn Connector, SourceError> {
        self.find(provider)
            .ok_or_else(|| SourceError::UnknownProvider(provider.to_owned()))
    }
}
