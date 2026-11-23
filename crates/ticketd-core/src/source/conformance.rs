//! Contract checks against a real configured source. Seeded fixtures also
//! exercise scenarios that cannot be inferred from a live tracker.

use std::{
    collections::{HashMap, HashSet},
    ops::ControlFlow,
};

use serde::Serialize;

use super::{
    Capability, ConfigValues, Connector, DiscoveryRequest, Engine, ErrorClass, ExternalIdentity,
    ExternalIssue, FieldKind, OptionSource, PublicationSearch, PublishRequest, SourceError,
    publication::check_destination,
};

#[cfg(test)]
mod fixtures;
#[cfg(test)]
pub(in crate::source) use fixtures::*;

const SAMPLE_SIZE: usize = 10;
const PROBE_PAGES: usize = 10;

#[derive(Debug, Default)]
pub struct ConformanceOptions {
    /// An explicit destination permits one creation and its recovery queries.
    pub publish: Option<String>,
    /// Require observations for advertised capabilities when they can be exercised.
    pub strict: bool,
}

#[derive(Debug, Serialize)]
pub struct ConformanceReport {
    pub provider: String,
    pub passed: bool,
    pub checks: Vec<ConformanceCheck>,
}

#[derive(Debug, Serialize)]
pub struct ConformanceCheck {
    pub name: &'static str,
    pub outcome: ConformanceOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConformanceOutcome {
    Passed,
    Failed,
    Skipped,
}

impl ConformanceReport {
    fn new(provider: &str) -> Self {
        Self {
            provider: provider.to_owned(),
            passed: true,
            checks: Vec::new(),
        }
    }

    fn pass(&mut self, name: &'static str) {
        self.push(name, ConformanceOutcome::Passed, None);
    }

    fn fail(&mut self, name: &'static str, reason: impl ToString) {
        self.passed = false;
        self.push(name, ConformanceOutcome::Failed, Some(reason.to_string()));
    }

    fn skip(&mut self, name: &'static str, reason: &'static str, strict: bool) {
        if strict {
            self.fail(name, reason);
        } else {
            self.push(name, ConformanceOutcome::Skipped, Some(reason.to_owned()));
        }
    }

    fn result(&mut self, name: &'static str, result: Result<(), SourceError>) {
        match result {
            Ok(()) => self.pass(name),
            Err(error) => self.fail(name, error),
        }
    }

    fn push(&mut self, name: &'static str, outcome: ConformanceOutcome, reason: Option<String>) {
        self.checks.push(ConformanceCheck {
            name,
            outcome,
            reason,
        });
    }
}

pub(super) fn run(
    engine: &Engine,
    provider: &str,
    raw: &ConfigValues,
    refusal: Result<(), SourceError>,
    options: &ConformanceOptions,
) -> Result<ConformanceReport, SourceError> {
    let descriptor = engine.descriptor(provider)?;
    let engine = engine.for_connection(provider, "conformance", raw);
    let connector = engine.connector(provider)?;
    let mut report = ConformanceReport::new(provider);
    report.result("version_refusal", refusal);
    let checked = engine
        .validate_configuration(provider, raw)
        .and_then(|config| engine.check(provider, &config).map(|check| (config, check)));
    let (config, connection) = match checked {
        Ok(checked) => {
            report.pass("handshake");
            report.pass("validate_and_check_connection");
            checked
        }
        Err(error) => {
            report.fail("validate_and_check_connection", error);
            return Ok(report);
        }
    };

    let mut invalid = config.clone();
    invalid.insert(
        "invalid setting (conformance probe)".into(),
        serde_json::Value::Bool(true),
    );
    let bad_settings = engine.validate_configuration(provider, &invalid);
    if matches!(bad_settings, Err(ref error) if error.class() == ErrorClass::Config && !error.issues().is_empty())
    {
        report.pass("invalid_configuration");
    } else {
        report.fail(
            "invalid_configuration",
            "unknown settings must produce field-level configuration errors",
        );
    }
    let suspect = descriptor.schema.fields.iter().any(|field| {
        !matches!(field.kind, FieldKind::Secret)
            && field.key.split(['_', '-']).any(|part| {
                matches!(
                    part.to_ascii_lowercase().as_str(),
                    "password" | "token" | "secret" | "credential"
                )
            })
    });
    if suspect {
        report.fail(
            "secret_fields",
            "a credential-like setting must be declared secret",
        );
    } else {
        report.pass("secret_fields");
    }
    if let Some(field) = descriptor.schema.fields.iter().find(|field| {
        matches!(
            field.kind,
            FieldKind::MultiSelect {
                options: OptionSource::Dynamic { .. },
                ..
            }
        )
    }) {
        report.result(
            "options",
            engine
                .options(provider, &field.key, "", &config)
                .map(|_| ()),
        );
    } else {
        report.skip("options", "the schema declares no dynamic selectors", false);
    }

    let paging = probe_pages(connector, &config);
    match paging {
        Ok(true) => report.pass("empty_continuation"),
        Ok(false) => report.skip(
            "empty_continuation",
            "the sampled pages had no empty continuation",
            false,
        ),
        Err(error) => report.fail("empty_continuation", error),
    }
    report.skip(
        "past_end_cursor",
        "the provider owns cursor syntax; a valid cursor beyond its data requires a seeded fixture",
        false,
    );

    let first = sample(&engine, provider, &config)?;
    if first.is_empty() {
        report.skip(
            "stable_identity",
            "discovery returned no issues to fetch",
            options.strict,
        );
        report.skip(
            "conversation",
            "discovery returned no issues with a conversation to check",
            options.strict && descriptor.capabilities.contains(&Capability::Comments),
        );
    } else {
        let repeated = sample(&engine, provider, &config)?;
        report.result(
            "stable_identity",
            verify_sample(
                &engine,
                provider,
                &config,
                &first,
                &repeated,
                &connection.derived.partitions,
            ),
        );
        if descriptor.capabilities.contains(&Capability::Comments) {
            let reference = &first[0].reference;
            let repeated_read =
                || comment_identity_set(connector.conversation(&config, reference)?.comments);
            report.result(
                "conversation",
                repeated_read().and_then(|first| {
                    let second = repeated_read()?;
                    require(
                        first == second,
                        "the same conversation returned different comment IDs",
                    )
                }),
            );
        } else {
            report.skip(
                "conversation",
                "the extension does not declare comments",
                false,
            );
        }
    }
    report.skip(
        "typed_closure_and_error_outcomes",
        "true tracker states and refused or lost writes require controlled fixtures",
        false,
    );

    match &options.publish {
        Some(destination) => report.result("publication", check_publication(&engine, provider, &config, &connection, destination)),
        None => report.skip(
            "publication",
            if descriptor.capabilities.contains(&Capability::Publish) {
                "read-only run; pass --publish with a destination to create one issue and check recovery"
            } else {
                "the extension does not declare publication"
            },
            false,
        ),
    }
    Ok(report)
}

fn probe_pages(connector: &dyn Connector, config: &ConfigValues) -> Result<bool, SourceError> {
    let mut cursor = None;
    let mut seen = HashSet::new();
    let mut empty_continuation = false;
    for _ in 0..PROBE_PAGES {
        let page = connector.discover(DiscoveryRequest {
            config,
            cursor: cursor.as_deref(),
            page_size: 1,
        })?;
        let Some(next) = page.next_cursor else {
            return Ok(empty_continuation);
        };
        require(
            seen.insert(next.clone()),
            "discovery repeated a continuation cursor",
        )?;
        empty_continuation |= page.issues.is_empty();
        cursor = Some(next);
    }
    Ok(empty_continuation)
}

fn sample(
    engine: &Engine,
    provider: &str,
    config: &ConfigValues,
) -> Result<Vec<ExternalIssue>, SourceError> {
    let mut issues = Vec::new();
    engine.discover(provider, config, |issue| {
        issues.push(issue);
        if issues.len() == SAMPLE_SIZE {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })?;
    Ok(issues)
}

fn verify_sample(
    engine: &Engine,
    provider: &str,
    config: &ConfigValues,
    first: &[ExternalIssue],
    repeated: &[ExternalIssue],
    partitions: &[String],
) -> Result<(), SourceError> {
    let repeated: HashMap<_, _> = repeated
        .iter()
        .map(|issue| (&issue.reference.locator, &issue.reference.identity))
        .collect();
    let mut distinct = HashSet::new();
    for issue in first {
        let identity = &issue.reference.identity;
        verify_identity(provider, identity)?;
        require(
            distinct.insert(identity),
            "discovery delivered the same identity twice",
        )?;
        require(
            partitions.contains(&issue.reference.partition),
            "a discovered issue named a part absent from the connection check",
        )?;
        if let Some(reobserved) = repeated.get(&issue.reference.locator) {
            require(
                *reobserved == identity,
                "a repeated discovery returned a different identity for the same locator",
            )?;
        }
        let fetched = engine.fetch(provider, config, &issue.reference)?;
        require(
            fetched.reference.identity == *identity,
            "list and fetch returned different identities",
        )?;
    }
    Ok(())
}

fn comment_identity_set(
    comments: Vec<super::ExternalComment>,
) -> Result<HashSet<String>, SourceError> {
    let mut ids = HashSet::new();
    for comment in comments {
        require(!comment.id.trim().is_empty(), "a comment has no stable ID")?;
        require(
            ids.insert(comment.id),
            "a conversation returned a comment ID more than once",
        )?;
    }
    Ok(ids)
}

fn check_publication(
    engine: &Engine,
    provider: &str,
    config: &ConfigValues,
    connection: &super::ConnectionCheck,
    destination: &str,
) -> Result<(), SourceError> {
    require(
        engine.can_publish(provider),
        "this extension does not declare publication",
    )?;
    check_destination(&connection.derived.publication, destination)?;
    let request = PublishRequest {
        title: format!("ticketd conformance {}", uuid::Uuid::new_v4()),
        body: "Created by an explicit ticketd source conformance publication check.".into(),
        destination: destination.into(),
    };
    let since = chrono::Utc::now().to_rfc3339();
    let issue = engine.publish(provider, config, &request)?;
    let located = engine.locate(provider, config, destination, &issue.display)?;
    require(
        issue.reference.identity == located.reference.identity,
        "locate did not return the created issue",
    )?;
    let search = PublicationSearch {
        request,
        since,
        account: Some(connection.connection.account.clone()),
    };
    let found = engine.find_published(provider, config, &search)?;
    require(
        found
            .matches
            .iter()
            .any(|candidate| candidate.reference.identity == issue.reference.identity),
        "the publication recovery search did not return the issue just created",
    )
}

pub(super) fn verify_identity(
    provider: &str,
    identity: &ExternalIdentity,
) -> Result<(), SourceError> {
    require(
        identity.provider == provider && !identity.id.trim().is_empty(),
        "an issue must have a stable ID under its source provider",
    )
}

fn require(condition: bool, message: &'static str) -> Result<(), SourceError> {
    if condition {
        Ok(())
    } else {
        Err(SourceError::Protocol(message.into()))
    }
}
