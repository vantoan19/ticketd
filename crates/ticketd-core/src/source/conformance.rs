//! Contract checks against a real configured source. Seeded fixtures also
//! exercise scenarios that cannot be inferred from a live tracker.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ops::ControlFlow,
};

use serde::{Deserialize, Serialize};

use super::{
    Capability, ConfigValues, Connector, DiscoveryRequest, Engine, ErrorClass, ExternalIssue,
    ExternalRef, FieldKind, OptionSource, PublicationSearch, PublishRequest, SourceError,
    StateCategory, engine::verify_identity, publication::check_destination,
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
    /// A provider-issued cursor known to be beyond the last page.
    pub past_end_cursor: Option<String>,
    /// Known issue states from an account or fixture prepared for conformance.
    pub closure_probes: Option<ClosureProbes>,
    /// Reasons for valid checks that the current setup cannot exercise.
    pub skip_reasons: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct ClosureProbes {
    pub open: ExternalRef,
    pub completed: ExternalRef,
    pub no_reason: ExternalRef,
    pub unknown_reason: ExternalRef,
    pub missing: ExternalRef,
    pub unreadable: ExternalRef,
}

impl ConformanceOptions {
    fn check_skip_reasons(&self) -> Result<(), SourceError> {
        for (check, reason) in &self.skip_reasons {
            if !matches!(
                check.as_str(),
                "cancellation"
                    | "empty_continuation"
                    | "past_end_cursor"
                    | "stable_identity"
                    | "conversation"
                    | "typed_closure"
                    | "publication_failure_outcomes"
            ) || reason.trim().is_empty()
            {
                return Err(SourceError::InvalidConfiguration(vec![
                    super::FieldIssue::for_form(
                        "a skip needs a supported conformance check name and a nonempty reason",
                    ),
                ]));
            }
        }
        Ok(())
    }
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

    fn unobserved(
        &mut self,
        name: &'static str,
        reason: &'static str,
        options: &ConformanceOptions,
    ) {
        if let Some(author_reason) = options.skip_reasons.get(name) {
            self.push(
                name,
                ConformanceOutcome::Skipped,
                Some(author_reason.trim().to_owned()),
            );
        } else if options.strict {
            self.fail(
                name,
                format!("{reason}; supply the fixture or pass --skip-check {name}=REASON"),
            );
        } else {
            self.skip(name, reason, false);
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
    options.check_skip_reasons()?;
    let descriptor = engine.descriptor(provider)?;
    let mut report = ConformanceReport::new(provider);
    report.result("version_refusal", refusal);
    // A test for one provider must not receive a credential intended for
    // another provider or a saved connection.
    let permitted_env = HashSet::new();
    let engine = match engine
        .for_connection_with_secret_refs(
            provider,
            "conformance",
            raw,
            &Default::default(),
            Some(&permitted_env),
        )
        .with_workflow_credentials(provider, raw)
    {
        Ok(engine) => engine,
        Err(error) => {
            report.fail("validate_and_check_connection", error);
            return Ok(report);
        }
    };
    let connector = engine.connector(provider)?;
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
        !matches!(field.kind, FieldKind::Secret | FieldKind::Link { .. })
            && [&field.key, &field.label].into_iter().any(|value| {
                let spaced = value.to_ascii_lowercase().replace(['_', '-'], " ");
                spaced.contains("api key")
                    || spaced.contains("private key")
                    || spaced.split_whitespace().any(|part| {
                        matches!(
                            part,
                            "password"
                                | "token"
                                | "secret"
                                | "credential"
                                | "apikey"
                                | "accesstoken"
                                | "refreshtoken"
                                | "clientsecret"
                                | "privatekey"
                        )
                    })
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

    let control = super::RefreshControl::cancellation_probe();
    if let Some(cancellable) = connector.for_refresh(&control) {
        let canceled = cancellable.discover(DiscoveryRequest {
            config: &config,
            cursor: None,
            page_size: SAMPLE_SIZE,
        });
        match canceled {
            Err(SourceError::RefreshCanceled) if control.acknowledged() => {
                report.pass("cancellation")
            }
            Err(SourceError::RefreshCanceled) => report.fail(
                "cancellation",
                "the extension did not acknowledge cancellation before the grace period expired",
            ),
            Ok(_) => report.unobserved(
                "cancellation",
                "the discover request returned before reporting progress",
                options,
            ),
            Err(error) => report.fail("cancellation", error),
        }
    }

    let paging = probe_pages(connector, &config);
    match paging {
        Ok(true) => report.pass("empty_continuation"),
        Ok(false) => report.unobserved(
            "empty_continuation",
            "the sampled pages had no empty continuation",
            options,
        ),
        Err(error) => report.fail("empty_continuation", error),
    }
    match options.past_end_cursor.as_deref() {
        Some(cursor) => report.result(
            "past_end_cursor",
            check_past_end(connector, &config, cursor),
        ),
        None => report.unobserved(
            "past_end_cursor",
            "a valid cursor beyond the tracker data requires a seeded fixture",
            options,
        ),
    }

    let first = sample(&engine, provider, &config);
    match &first {
        Ok(first) if !first.is_empty() => {
            let repeated = sample(&engine, provider, &config).and_then(|repeated| {
                verify_sample(
                    &engine,
                    provider,
                    &config,
                    first,
                    &repeated,
                    &connection.derived.partitions,
                )
            });
            match repeated {
                Ok(true) => report.pass("stable_identity"),
                Ok(false) => report.unobserved(
                    "stable_identity",
                    "no locator was observed in both discovery samples",
                    options,
                ),
                Err(error) => report.fail("stable_identity", error),
            }
        }
        Ok(_) => report.unobserved(
            "stable_identity",
            "discovery returned no issues to fetch",
            options,
        ),
        Err(error) => report.fail("stable_identity", error),
    }
    if !descriptor.capabilities.contains(&Capability::Comments) {
        report.skip(
            "conversation",
            "the extension does not declare comments",
            false,
        );
    } else {
        match first {
            Ok(issues) => match verify_conversation(connector, &config, &issues) {
                Ok(true) => report.pass("conversation"),
                Ok(false) => report.unobserved(
                    "conversation",
                    "no populated conversation was observed",
                    options,
                ),
                Err(error) => report.fail("conversation", error),
            },
            Err(_) => report.skip(
                "conversation",
                "discovery failed before a conversation could be checked",
                false,
            ),
        }
    }
    match options.closure_probes.as_ref() {
        Some(probes) => report.result("typed_closure", check_closures(connector, &config, probes)),
        None => report.unobserved(
            "typed_closure",
            "known tracker states require a seeded fixture",
            options,
        ),
    }
    if options.publish.is_some() {
        report.unobserved(
            "publication_failure_outcomes",
            "refused and lost mutations require a controlled tracker fixture",
            options,
        );
    } else {
        report.skip("publication_failure_outcomes", "read-only run", false);
    }

    match &options.publish {
        Some(destination) if report.passed => report.result("publication", check_publication(&engine, provider, &config, &connection, destination)),
        Some(_) => report.skip("publication", "another conformance check failed before publication", false),
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

fn check_past_end(
    connector: &dyn Connector,
    config: &ConfigValues,
    cursor: &str,
) -> Result<(), SourceError> {
    let page = connector.discover(DiscoveryRequest {
        config,
        cursor: Some(cursor),
        page_size: SAMPLE_SIZE,
    })?;
    require(
        page.issues.is_empty() && page.next_cursor.is_none() && page.skipped.is_empty(),
        "a cursor past the last page must return no issues, skipped parts or continuation",
    )
}

fn check_closures(
    connector: &dyn Connector,
    config: &ConfigValues,
    probes: &ClosureProbes,
) -> Result<(), SourceError> {
    for (reference, category) in [
        (&probes.open, StateCategory::Open),
        (&probes.completed, StateCategory::Completed),
        (&probes.no_reason, StateCategory::Unknown),
        (&probes.unknown_reason, StateCategory::Unknown),
    ] {
        let issue = connector.fetch(config, reference)?;
        require(
            issue.reference.identity == reference.identity,
            "a closure probe returned a different issue ID",
        )?;
        if issue.state.category != category {
            return Err(SourceError::Protocol(format!(
                "closure probe {} returned {:?}, expected {category:?}",
                reference.locator, issue.state.category,
            )));
        }
    }
    for reference in [&probes.missing, &probes.unreadable] {
        require(
            connector.fetch(config, reference).is_err(),
            "a missing or unreadable issue must return a failure",
        )?;
    }
    Ok(())
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
) -> Result<bool, SourceError> {
    let repeated: HashMap<_, _> = repeated
        .iter()
        .map(|issue| (&issue.reference.locator, &issue.reference.identity))
        .collect();
    let mut distinct = HashSet::new();
    let mut observed_again = false;
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
            observed_again = true;
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
    Ok(observed_again)
}

fn verify_conversation(
    connector: &dyn Connector,
    config: &ConfigValues,
    issues: &[ExternalIssue],
) -> Result<bool, SourceError> {
    for issue in issues {
        let reference = &issue.reference;
        let initial = connector.conversation(config, reference)?;
        if initial.comments.is_empty() && initial.events.is_empty() {
            continue;
        }
        let repeated = connector.conversation(config, reference)?;
        require(
            conversation_ids(initial.comments.into_iter().map(|entry| entry.id))?
                == conversation_ids(repeated.comments.into_iter().map(|entry| entry.id))?,
            "the same conversation returned different comment IDs",
        )?;
        require(
            conversation_ids(initial.events.into_iter().map(|entry| entry.id))?
                == conversation_ids(repeated.events.into_iter().map(|entry| entry.id))?,
            "the same conversation returned different event IDs",
        )?;
        return Ok(true);
    }
    Ok(false)
}

fn conversation_ids(
    entries: impl IntoIterator<Item = String>,
) -> Result<HashSet<String>, SourceError> {
    let mut ids = HashSet::new();
    for id in entries {
        require(
            !id.trim().is_empty(),
            "a conversation record has no stable ID",
        )?;
        require(
            ids.insert(id),
            "a conversation returned an ID more than once in the same record type",
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
    require(
        !connection.connection.publication_requires_tracker_time
            || connection
                .connection
                .tracker_time
                .as_deref()
                .is_some_and(|time| chrono::DateTime::parse_from_rfc3339(time).is_ok()),
        "the source did not confirm its clock for publication recovery",
    )?;
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
        tracker_since: connection.connection.tracker_time.clone(),
        account: Some(connection.connection.account_key().to_owned()),
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

fn require(condition: bool, message: &'static str) -> Result<(), SourceError> {
    if condition {
        Ok(())
    } else {
        Err(SourceError::Protocol(message.into()))
    }
}
