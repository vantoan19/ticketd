//! Device-local development links and the process connector.

mod host;
mod logs;
mod process;
mod redaction;
mod registry;
mod wire;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use serde::de::DeserializeOwned;

use super::{
    CONTRACT_VERSION, Capability, ChoiceOption, ConfigValues, ConnectionCheck, Connector,
    ConnectorDescriptor, Conversation, DiscoveryPage, DiscoveryRequest, ExternalIssue, ExternalRef,
    FieldIssue, FieldKind, Publication, PublicationCandidates, PublicationSearch, PublishRequest,
    RefreshControl, SourceDescription, SourceError, SourcePresentation, credentials,
};
use host::{Definition, Host};
use registry::Launch;
use wire::{Call, ConnectionParams, IssueParams};

pub(super) use process::password_output;
pub use registry::{ExtensionConsent, ExtensionRegistry, PreparedExtension, RegisteredExtension};

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
    host: Arc<Host>,
    refresh: Option<RefreshControl>,
}

impl ProcessConnector {
    fn request<'a, T: DeserializeOwned>(
        &'a self,
        config: &'a ConfigValues,
        call: impl FnOnce(ConnectionParams<'a>) -> Call<'a>,
    ) -> Result<T, SourceError> {
        if let Some(refresh) = &self.refresh {
            refresh.check()?;
        }
        let id = self.connection_id()?;
        let resolved = credentials::resolve(
            &self.description.descriptor.schema,
            id,
            &self.credentials,
            config,
        )?;
        self.call(
            id,
            &resolved,
            call(ConnectionParams {
                connection_id: id,
                config,
            }),
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

    fn for_connection(&self, id: &str, config: &ConfigValues) -> Option<Box<dyn Connector>> {
        self.for_connection_with_secret_refs(id, config, Default::default())
    }

    fn for_connection_with_secret_refs(
        &self,
        id: &str,
        _config: &ConfigValues,
        credentials: credentials::References,
    ) -> Option<Box<dyn Connector>> {
        Some(Box::new(Self {
            connection_id: Some(id.to_owned()),
            credentials,
            ..self.clone()
        }))
    }

    fn validate_draft(&self, raw: &ConfigValues) -> Result<ConfigValues, SourceError> {
        let id = self.connection_id()?;
        let schema = &self.description.descriptor.schema;
        let resolved = credentials::resolve(schema, id, &self.credentials, raw)?;
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
                connection_id: id,
                config: &config,
            }),
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
            field,
            query,
        })
    }

    fn discover(&self, request: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError> {
        self.request(request.config, |connection| Call::Discover {
            connection,
            cursor: request.cursor,
            page_size: request.page_size,
        })
    }

    fn fetch(
        &self,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        self.request(config, |connection| {
            Call::Fetch(IssueParams {
                connection,
                reference,
            })
        })
    }

    fn conversation(
        &self,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<Conversation, SourceError> {
        self.request(config, |connection| {
            Call::Conversation(IssueParams {
                connection,
                reference,
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
        self.request(config, |connection| Call::Publish {
            connection,
            request,
        })
    }

    fn locate(
        &self,
        config: &ConfigValues,
        destination: &str,
        text: &str,
    ) -> Result<ExternalIssue, SourceError> {
        self.request(config, |connection| Call::Locate {
            connection,
            destination,
            text,
        })
    }

    fn find_published(
        &self,
        config: &ConfigValues,
        search: &PublicationSearch,
    ) -> Result<PublicationCandidates, SourceError> {
        self.request(config, |connection| Call::FindPublished {
            connection,
            search,
        })
    }
}
