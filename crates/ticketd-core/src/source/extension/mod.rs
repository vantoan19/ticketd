//! Device-local development links and the process connector.

mod add;
mod host;
mod logs;
mod process;
mod redaction;
mod registry;
mod wire;

#[cfg(test)]
mod tests;

use std::{borrow::Cow, sync::Arc};

use serde::de::DeserializeOwned;

use super::{
    CONTRACT_VERSION, Capability, ChoiceOption, ConfigValues, ConnectionCheck, Connector,
    ConnectorDescriptor, Conversation, DiscoveryPage, DiscoveryRequest, ExternalIssue, ExternalRef,
    FieldIssue, FieldKind, Publication, PublicationCandidates, PublicationSearch, PublishRequest,
    RefreshControl, SourceDescription, SourceError, SourcePresentation, credentials,
    engine::verify_issue_timestamps,
};
use host::{Definition, Host};
use registry::Launch;
use wire::{Call, ConnectionParams, IssueParams};

pub(super) use process::password_output;
pub use add::{AddError, FolderRefusal, PendingConsent, PendingExtensions, check_extension_folder};
pub use registry::{
    ExtensionConsent, ExtensionRegistry, ExtensionState, PreparedExtension, RegisteredExtension,
};

/// The published JSON Schema generated from the types that encode and decode
/// messages on the process boundary.
pub fn contract_schema() -> schemars::Schema {
    wire::schema()
}

#[derive(Clone)]
struct ProcessConnector {
    definition: Definition,
    description: SourceDescription,
    connection_id: Option<String>,
    credentials: credentials::References,
    permitted_env: Option<std::collections::HashSet<String>>,
    workflow_credentials: Option<Arc<ConfigValues>>,
    host: Arc<Host>,
    refresh: Option<RefreshControl>,
}

impl ProcessConnector {
    fn request<'a, T: DeserializeOwned>(
        &'a self,
        config: &'a ConfigValues,
        call: impl FnOnce(ConnectionParams<'a>) -> Call<'a>,
    ) -> Result<T, SourceError> {
        self.request_before(config, call, None)
    }

    fn request_before<'a, T: DeserializeOwned>(
        &'a self,
        config: &'a ConfigValues,
        call: impl FnOnce(ConnectionParams<'a>) -> Call<'a>,
        deadline: Option<std::time::Instant>,
    ) -> Result<T, SourceError> {
        if let Some(refresh) = &self.refresh {
            refresh.check()?;
        }
        let id = self.connection_id()?;
        let resolved = self.resolve_credentials(id, config)?;
        let call = call(ConnectionParams {
            connection_id: id.into(),
            config: Cow::Borrowed(config),
        });
        // Setup can load options and verify credentials before discovery rules
        // are complete. Issue operations always require a full configuration.
        let schema = &self.description.descriptor.schema;
        let resolved = match &call {
            Call::Options { .. } => Ok(resolved),
            Call::CheckConnection(_) => schema.validate_connection_draft(&resolved),
            _ => schema.validate(&resolved),
        }
        .map_err(SourceError::InvalidConfiguration)?;
        self.call(id, &resolved, call, deadline)
    }

    fn request_issue<'a>(
        &'a self,
        config: &'a ConfigValues,
        call: impl FnOnce(ConnectionParams<'a>) -> Call<'a>,
        deadline: Option<std::time::Instant>,
    ) -> Result<ExternalIssue, SourceError> {
        let issue = self.request_before(config, call, deadline)?;
        verify_issue_timestamps(&issue, true)?;
        Ok(issue)
    }

    fn resolve_credentials(
        &self,
        id: &str,
        raw: &ConfigValues,
    ) -> Result<ConfigValues, SourceError> {
        if let Some(credentials) = &self.workflow_credentials {
            let mut resolved = raw.clone();
            for field in &self.description.descriptor.schema.fields {
                if matches!(field.kind, FieldKind::Secret) {
                    resolved.remove(&field.key);
                }
            }
            resolved.extend(
                credentials
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
            return Ok(resolved);
        }
        credentials::resolve(
            &self.description.descriptor.schema,
            id,
            &self.credentials,
            self.permitted_env.as_ref(),
            raw,
        )
    }

    fn connection_id(&self) -> Result<&str, SourceError> {
        self.connection_id.as_deref().ok_or_else(|| {
            SourceError::Protocol("a source extension operation requires a connection ID".into())
        })
    }

    fn call<T: DeserializeOwned>(
        &self,
        id: &str,
        resolved: &ConfigValues,
        call: Call<'_>,
        deadline: Option<std::time::Instant>,
    ) -> Result<T, SourceError> {
        let secrets = self
            .description
            .descriptor
            .schema
            .fields
            .iter()
            .filter(|field| matches!(field.kind, FieldKind::Secret))
            .filter_map(|field| resolved.get(&field.key).and_then(serde_json::Value::as_str));
        self.host.call_controlled(
            &self.definition,
            Some(id),
            call.with_config(resolved),
            self.refresh.as_ref(),
            &secrets.collect::<Vec<_>>(),
            deadline,
        )
    }
}

impl Connector for ProcessConnector {
    fn descriptor(&self) -> ConnectorDescriptor {
        self.description.descriptor.clone()
    }

    fn presentation(&self) -> SourcePresentation {
        self.description.presentation.clone()
    }

    fn configuration_for_request(&self, raw: &ConfigValues) -> Result<ConfigValues, SourceError> {
        Ok(raw.clone())
    }

    fn for_connection(&self, id: &str, config: &ConfigValues) -> Option<Box<dyn Connector>> {
        self.for_connection_with_secret_refs(id, config, Default::default(), None)
    }

    fn for_connection_with_secret_refs(
        &self,
        id: &str,
        _config: &ConfigValues,
        credentials: credentials::References,
        permitted_env: Option<std::collections::HashSet<String>>,
    ) -> Option<Box<dyn Connector>> {
        Some(Box::new(Self {
            connection_id: Some(id.to_owned()),
            credentials,
            permitted_env,
            workflow_credentials: None,
            ..self.clone()
        }))
    }

    fn validate_draft(&self, raw: &ConfigValues) -> Result<ConfigValues, SourceError> {
        let id = self.connection_id()?;
        let schema = &self.description.descriptor.schema;
        let resolved = self.resolve_credentials(id, raw)?;
        let redactions = redaction::Redactions::default();
        redactions.register(schema.fields.iter().filter_map(|field| {
            if matches!(field.kind, FieldKind::Secret) {
                resolved.get(&field.key).and_then(serde_json::Value::as_str)
            } else {
                None
            }
        }));
        for field in &schema.fields {
            if !matches!(field.kind, FieldKind::Secret)
                && schema.is_active(field, &resolved)
                && resolved
                    .get(&field.key)
                    .is_some_and(|value| redactions.contains_secret(value))
            {
                return Err(SourceError::InvalidConfiguration(vec![
                    FieldIssue::for_field(
                        &field.key,
                        "contains a credential; enter it in its credential field",
                    ),
                ]));
            }
        }
        let mut config = schema
            .validate(&resolved)
            .map_err(SourceError::InvalidConfiguration)?;
        let issues: Vec<FieldIssue> = self.call(
            id,
            &config,
            Call::Validate(ConnectionParams {
                connection_id: id.into(),
                config: Cow::Borrowed(&config),
            }),
            None,
        )?;
        if !issues.is_empty() {
            return Err(SourceError::InvalidConfiguration(issues));
        }
        for field in &schema.fields {
            if matches!(field.kind, FieldKind::Secret)
                && raw
                    .get(&field.key)
                    .is_none_or(|value| !super::schema::has_value(value))
            {
                config.remove(&field.key);
            }
        }
        Ok(config)
    }

    fn with_workflow_credentials(
        &self,
        config: &ConfigValues,
    ) -> Result<Option<Box<dyn Connector>>, SourceError> {
        if self.workflow_credentials.is_some() {
            return Ok(None);
        }
        let mut resolved = self.resolve_credentials(self.connection_id()?, config)?;
        let schema = &self.description.descriptor.schema;
        resolved.retain(|key, _| {
            schema
                .field(key)
                .is_some_and(|field| matches!(field.kind, FieldKind::Secret))
        });
        Ok(Some(Box::new(Self {
            workflow_credentials: Some(Arc::new(resolved)),
            ..self.clone()
        })))
    }

    fn for_refresh(&self, control: &RefreshControl) -> Option<Box<dyn Connector>> {
        Some(Box::new(Self {
            refresh: Some(control.clone()),
            ..self.clone()
        }))
    }

    fn validate(&self, config: &ConfigValues) -> Result<Vec<FieldIssue>, SourceError> {
        self.request(config, Call::Validate)
    }

    fn check_connection(&self, config: &ConfigValues) -> Result<ConnectionCheck, SourceError> {
        self.request(config, Call::CheckConnection)
    }

    fn options(
        &self,
        field: &str,
        query: &str,
        config: &ConfigValues,
    ) -> Result<Vec<ChoiceOption>, SourceError> {
        self.request(config, |connection| Call::Options {
            connection,
            field: field.into(),
            query: query.into(),
        })
    }

    fn discover(&self, request: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError> {
        let page: DiscoveryPage = self.request(request.config, |connection| Call::Discover {
            connection,
            cursor: request.cursor.map(Cow::Borrowed),
            page_size: request.page_size,
        })?;
        for issue in &page.issues {
            verify_issue_timestamps(issue, true)?;
        }
        Ok(page)
    }

    fn fetch(
        &self,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        self.request_issue(
            config,
            |connection| {
                Call::Fetch(IssueParams {
                    connection,
                    reference: Cow::Borrowed(reference),
                })
            },
            None,
        )
    }

    fn conversation(
        &self,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<Conversation, SourceError> {
        self.request(config, |connection| {
            Call::Conversation(IssueParams {
                connection,
                reference: Cow::Borrowed(reference),
            })
        })
    }

    fn publication(&self) -> Option<&dyn Publication> {
        self.description
            .descriptor
            .capabilities
            .contains(&Capability::Publish)
            .then_some(self)
    }
}

impl Publication for ProcessConnector {
    fn publish(
        &self,
        config: &ConfigValues,
        request: &PublishRequest,
    ) -> Result<ExternalIssue, SourceError> {
        self.request_issue(
            config,
            |connection| Call::Publish {
                connection,
                request: Cow::Borrowed(request),
            },
            None,
        )
    }

    fn publish_before(
        &self,
        config: &ConfigValues,
        request: &PublishRequest,
        deadline: std::time::Instant,
    ) -> Result<ExternalIssue, SourceError> {
        self.request_issue(
            config,
            |connection| Call::Publish {
                connection,
                request: Cow::Borrowed(request),
            },
            Some(deadline),
        )
    }

    fn locate(
        &self,
        config: &ConfigValues,
        destination: &str,
        text: &str,
    ) -> Result<ExternalIssue, SourceError> {
        self.request_issue(
            config,
            |connection| Call::Locate {
                connection,
                destination: destination.into(),
                text: text.into(),
            },
            None,
        )
    }

    fn find_published(
        &self,
        config: &ConfigValues,
        search: &PublicationSearch,
    ) -> Result<PublicationCandidates, SourceError> {
        let candidates: PublicationCandidates =
            self.request(config, |connection| Call::FindPublished {
                connection,
                search: Cow::Borrowed(search),
            })?;
        for issue in candidates.matches.iter().chain(&candidates.recent) {
            verify_issue_timestamps(issue, true)?;
        }
        Ok(candidates)
    }
}
