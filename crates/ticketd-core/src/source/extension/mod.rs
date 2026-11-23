//! Device-local development links and the process connector.

mod host;
mod process;
mod registry;
mod wire;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use serde::de::DeserializeOwned;

use super::{
    CONTRACT_VERSION, Capability, ChoiceOption, ConfigValues, ConnectionCheck, Connector,
    ConnectorDescriptor, Conversation, DiscoveryPage, DiscoveryRequest, ExternalIssue, ExternalRef,
    FieldIssue, Publication, PublicationCandidates, PublicationSearch, PublishRequest,
    SourceDescription, SourceError, SourcePresentation,
};
use host::{Definition, Host};
use registry::Launch;
use wire::{Call, ConnectionParams, IssueParams};

pub use registry::{ExtensionRegistry, LinkedExtension};

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
    host: Arc<Host>,
}

impl ProcessConnector {
    fn request<'a, T: DeserializeOwned>(
        &'a self,
        config: &'a ConfigValues,
        call: impl FnOnce(ConnectionParams<'a>) -> Call<'a>,
    ) -> Result<T, SourceError> {
        let id = self.connection_id.as_deref().ok_or_else(|| {
            SourceError::Protocol("a source extension operation requires a connection ID".into())
        })?;
        self.host.call(
            &self.definition,
            Some(id),
            call(ConnectionParams {
                connection_id: id,
                config,
            }),
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

    fn for_connection(&self, id: &str, _config: &ConfigValues) -> Option<Box<dyn Connector>> {
        Some(Box::new(Self {
            connection_id: Some(id.to_owned()),
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
