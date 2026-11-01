//! Source configuration through the workspace workflow boundary, using a
//! controllable fake connector instead of any provider transport.
#![allow(clippy::unwrap_used)]

use std::{
    collections::VecDeque,
    ops::ControlFlow,
    sync::{Arc, Mutex},
};

use serde_json::{Value, json};
use ticketd_core::{
    Error, Workspace,
    source::{
        CONTRACT_VERSION, Capability, ChoiceOption, ConfigSchema, ConfigValues, ConnectionInfo,
        Connector, ConnectorDescriptor, DiscoveryPage, DiscoveryRequest, Engine, ExternalIdentity,
        ExternalIssue, ExternalRef, ExternalState, FieldKind, OptionSource, SchemaField,
        SourceError, ValueFormat,
    },
};

#[derive(Default)]
struct State {
    /// Pages returned in order; each is (issues, has_more).
    pages: VecDeque<Result<(Vec<ExternalIssue>, bool), String>>,
    connection_error: Option<String>,
    cursors_seen: Vec<Option<String>>,
    configs_seen: Vec<ConfigValues>,
    version: Option<u32>,
}

#[derive(Clone, Default)]
struct Fake(Arc<Mutex<State>>);

impl Connector for Fake {
    fn descriptor(&self) -> ConnectorDescriptor {
        ConnectorDescriptor {
            provider: "fake".into(),
            name: "Fake".into(),
            contract_version: self.0.lock().unwrap().version.unwrap_or(CONTRACT_VERSION),
            capabilities: vec![Capability::Discover, Capability::Fetch],
            schema: ConfigSchema {
                fields: vec![
                    SchemaField {
                        key: "repositories".into(),
                        label: "Repositories".into(),
                        help: None,
                        required: true,
                        kind: FieldKind::MultiSelect {
                            options: OptionSource::Dynamic { depends_on: vec![] },
                            allow_custom: true,
                            min_items: 1,
                            max_items: 3,
                            format: Some(ValueFormat::OwnerName),
                        },
                    },
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
                ],
            },
        }
    }

    fn check_connection(&self, _config: &ConfigValues) -> Result<ConnectionInfo, SourceError> {
        match self.0.lock().unwrap().connection_error.clone() {
            Some(message) => Err(SourceError::Unauthenticated(message)),
            None => Ok(ConnectionInfo {
                account: "octo".into(),
            }),
        }
    }

    fn options(
        &self,
        _field: &str,
        query: &str,
        _config: &ConfigValues,
    ) -> Result<Vec<ChoiceOption>, SourceError> {
        Ok(vec![ChoiceOption {
            value: format!("o/{query}"),
            label: format!("o/{query}"),
            description: None,
        }])
    }

    fn discover(&self, request: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError> {
        let mut state = self.0.lock().unwrap();
        state.cursors_seen.push(request.cursor.map(str::to_owned));
        state.configs_seen.push(request.config.clone());
        match state.pages.pop_front() {
            None => Ok(DiscoveryPage {
                issues: Vec::new(),
                next_cursor: None,
            }),
            Some(Err(message)) => Err(SourceError::Unavailable(message)),
            Some(Ok((issues, more))) => {
                let next = format!("page-{}", state.cursors_seen.len());
                Ok(DiscoveryPage {
                    issues,
                    next_cursor: more.then_some(next),
                })
            }
        }
    }

    fn fetch(
        &self,
        _config: &ConfigValues,
        _reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError> {
        Err(SourceError::NotFound("gone".into()))
    }
}

fn issue(id: u64) -> ExternalIssue {
    ExternalIssue {
        reference: ExternalRef {
            identity: ExternalIdentity {
                provider: "fake".into(),
                id: id.to_string(),
            },
            locator: format!("o/r#{id}"),
        },
        display: format!("o/r#{id}"),
        url: format!("https://example.test/{id}"),
        title: format!("Issue {id}"),
        body: "private description".into(),
        state: ExternalState::Open,
        assignees: vec![],
        labels: vec![],
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn values(value: Value) -> ConfigValues {
    value.as_object().unwrap().clone()
}

fn setup() -> (Fake, Engine) {
    let fake = Fake::default();
    let mut engine = Engine::new();
    engine.register(Box::new(fake.clone())).unwrap();
    (fake, engine)
}

fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    (dir, workspace)
}

#[test]
fn schema_validation_reports_every_problem_and_normalizes_values() {
    let (_, engine) = setup();
    let schema = engine.descriptor("fake").unwrap().schema;

    let issues = schema
        .validate(&values(
            json!({"repositories": ["bad", "a/b/c"], "assignee": "-x-", "extra": 1}),
        ))
        .unwrap_err();
    let fields: Vec<_> = issues.iter().map(|i| i.field.as_str()).collect();
    assert_eq!(
        fields,
        ["extra", "repositories", "repositories", "assignee"]
    );

    let missing = schema
        .validate(&values(json!({"assignee": "octo"})))
        .unwrap_err();
    assert_eq!(missing[0].message, "is required");

    let too_many = schema
        .validate(&values(
            json!({"repositories": ["a/1", "a/2", "a/3", "a/4"]}),
        ))
        .unwrap_err();
    assert!(too_many[0].message.contains("at most 3"));

    let normalized = schema
        .validate(&values(
            json!({"repositories": [" o/r ", "o/r", "o/s", ""], "assignee": "  "}),
        ))
        .unwrap();
    assert_eq!(normalized, values(json!({"repositories": ["o/r", "o/s"]})));
}

#[test]
fn command_line_assignments_build_the_same_values_as_a_form() {
    let (_, engine) = setup();
    let schema = engine.descriptor("fake").unwrap().schema;
    let raw = schema
        .values_from_assignments(&[
            "repositories=o/a,o/b".into(),
            "repositories=o/c".into(),
            "assignee=octo".into(),
        ])
        .unwrap();
    assert_eq!(
        schema.validate(&raw).unwrap(),
        values(json!({"repositories": ["o/a", "o/b", "o/c"], "assignee": "octo"}))
    );
    assert!(
        schema
            .values_from_assignments(&["nonsense".into()])
            .is_err()
    );
    assert!(
        schema
            .values_from_assignments(&["assignee=a".into(), "assignee=b".into()])
            .is_err()
    );
}

#[test]
fn preview_walks_every_page_and_lists_without_importing() {
    let (fake, engine) = setup();
    {
        let mut state = fake.0.lock().unwrap();
        state.pages.push_back(Ok((vec![issue(1), issue(2)], true)));
        state.pages.push_back(Ok((vec![], true))); // an empty page is not the end
        state.pages.push_back(Ok((vec![issue(2), issue(3)], false))); // 2 repeats
    }
    let (_dir, workspace) = workspace();
    let preview = engine
        .preview("fake", &values(json!({"repositories": ["o/r"]})))
        .unwrap();
    assert_eq!(preview.account, "octo");
    assert_eq!((preview.matched, preview.complete), (3, true));
    let displays: Vec<_> = preview.issues.iter().map(|i| i.display.as_str()).collect();
    assert_eq!(displays, ["o/r#1", "o/r#2", "o/r#3"]);
    // The continuation of each page was passed to the next request.
    let cursors = fake.0.lock().unwrap().cursors_seen.clone();
    assert_eq!(
        cursors,
        [None, Some("page-1".into()), Some("page-2".into())]
    );
    // Previewing imports nothing and the preview never carries descriptions.
    assert!(workspace.list_tickets().unwrap().is_empty());
    assert!(
        !serde_json::to_string(&preview)
            .unwrap()
            .contains("private description")
    );
}

#[test]
fn an_empty_result_is_a_valid_preview() {
    let (_, engine) = setup();
    let preview = engine
        .preview("fake", &values(json!({"repositories": ["o/r"]})))
        .unwrap();
    assert_eq!(
        (preview.matched, preview.complete, preview.issues.len()),
        (0, true, 0)
    );
}

#[test]
fn a_large_preview_lists_a_page_and_says_the_count_is_partial() {
    let (fake, engine) = setup();
    let batch = |from: u64| (from..from + 100).map(issue).collect::<Vec<_>>();
    {
        let mut state = fake.0.lock().unwrap();
        state.pages.push_back(Ok((batch(0), true)));
        state.pages.push_back(Ok((batch(100), true)));
        state.pages.push_back(Ok((batch(200), false)));
    }
    let preview = engine
        .preview("fake", &values(json!({"repositories": ["o/r"]})))
        .unwrap();
    assert_eq!(
        (preview.matched, preview.complete, preview.issues.len()),
        (200, false, 25)
    );
    assert_eq!(fake.0.lock().unwrap().cursors_seen.len(), 2);
}

#[test]
fn provider_failures_surface_and_a_looping_connector_is_stopped() {
    let (fake, engine) = setup();
    let config = values(json!({"repositories": ["o/r"]}));

    fake.0.lock().unwrap().connection_error = Some("sign in first".into());
    let error = engine.preview("fake", &config).unwrap_err();
    assert_eq!(error.code(), "unauthenticated");
    fake.0.lock().unwrap().connection_error = None;

    fake.0.lock().unwrap().pages.push_back(Err("down".into()));
    assert_eq!(
        engine.preview("fake", &config).unwrap_err().code(),
        "unavailable"
    );

    // Always more pages, but a cursor that never changes would loop forever:
    // the fake numbers cursors, so make them repeat via identical page counts.
    let endless = Fake::default();
    struct Stuck(Fake);
    impl Connector for Stuck {
        fn descriptor(&self) -> ConnectorDescriptor {
            self.0.descriptor()
        }
        fn check_connection(&self, c: &ConfigValues) -> Result<ConnectionInfo, SourceError> {
            self.0.check_connection(c)
        }
        fn options(
            &self,
            f: &str,
            q: &str,
            c: &ConfigValues,
        ) -> Result<Vec<ChoiceOption>, SourceError> {
            self.0.options(f, q, c)
        }
        fn discover(&self, _: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError> {
            Ok(DiscoveryPage {
                issues: vec![],
                next_cursor: Some("same".into()),
            })
        }
        fn fetch(&self, c: &ConfigValues, r: &ExternalRef) -> Result<ExternalIssue, SourceError> {
            self.0.fetch(c, r)
        }
    }
    let mut stuck = Engine::new();
    stuck.register(Box::new(Stuck(endless))).unwrap();
    let error = stuck.preview("fake", &config).unwrap_err();
    assert_eq!(error.code(), "protocol");
}

#[test]
fn the_engine_visitor_can_stop_early_and_foreign_identities_are_rejected() {
    let (fake, engine) = setup();
    fake.0
        .lock()
        .unwrap()
        .pages
        .push_back(Ok(((1..=5).map(issue).collect(), true)));
    let mut taken = 0;
    let summary = engine
        .discover("fake", &values(json!({"repositories": ["o/r"]})), |_| {
            taken += 1;
            if taken == 2 {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        })
        .unwrap();
    assert_eq!((summary.seen, summary.complete), (2, false));

    let mut foreign = issue(9);
    foreign.reference.identity.provider = "other".into();
    fake.0
        .lock()
        .unwrap()
        .pages
        .push_back(Ok((vec![foreign], false)));
    let error = engine
        .discover("fake", &values(json!({"repositories": ["o/r"]})), |_| {
            ControlFlow::Continue(())
        })
        .unwrap_err();
    assert_eq!(error.code(), "protocol");
}

#[test]
fn a_connector_with_another_contract_version_is_refused() {
    let fake = Fake::default();
    fake.0.lock().unwrap().version = Some(CONTRACT_VERSION + 1);
    let mut engine = Engine::new();
    let error = engine.register(Box::new(fake)).unwrap_err();
    assert_eq!(error.code(), "incompatible_contract");
    assert!(engine.connectors().is_empty());
    assert_eq!(
        engine
            .preview("fake", &ConfigValues::new())
            .unwrap_err()
            .code(),
        "unknown_provider"
    );
}

#[test]
fn dynamic_options_are_offered_only_for_dynamic_fields() {
    let (_, engine) = setup();
    let options = engine
        .options("fake", "repositories", "abc", &ConfigValues::new())
        .unwrap();
    assert_eq!(options[0].value, "o/abc");
    let error = engine
        .options("fake", "assignee", "x", &ConfigValues::new())
        .unwrap_err();
    assert_eq!(error.code(), "invalid_configuration");
}

#[test]
fn saved_configuration_survives_reopening_and_imports_nothing() {
    let (fake, engine) = setup();
    let (dir, mut workspace) = workspace();
    assert!(workspace.saved_source("fake").unwrap().is_none());
    fake.0
        .lock()
        .unwrap()
        .pages
        .push_back(Ok((vec![issue(1)], false)));

    let outcome = workspace
        .save_source(
            &engine,
            "fake",
            &values(json!({"repositories": [" o/r "], "assignee": "octo"})),
        )
        .unwrap();
    assert_eq!(outcome.preview.matched, 1);
    assert_eq!(outcome.source.account, "octo");
    assert_eq!(
        outcome.source.config,
        values(json!({"repositories": ["o/r"], "assignee": "octo"}))
    );
    assert!(workspace.list_tickets().unwrap().is_empty());
    drop(workspace);

    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    assert_eq!(
        workspace.saved_source("fake").unwrap().unwrap(),
        outcome.source
    );
    assert_eq!(workspace.saved_sources().unwrap().len(), 1);
}

#[test]
fn a_failed_validation_or_preview_leaves_the_saved_configuration_unchanged() {
    let (fake, engine) = setup();
    let (_dir, mut workspace) = workspace();
    let original = values(json!({"repositories": ["o/r"]}));
    workspace.save_source(&engine, "fake", &original).unwrap();

    let invalid = workspace
        .save_source(&engine, "fake", &values(json!({"repositories": ["nope"]})))
        .unwrap_err();
    assert!(matches!(
        invalid,
        Error::Source(SourceError::InvalidConfiguration(_))
    ));

    fake.0.lock().unwrap().connection_error = Some("expired".into());
    assert!(
        workspace
            .save_source(
                &engine,
                "fake",
                &values(json!({"repositories": ["o/other"]}))
            )
            .is_err()
    );
    fake.0.lock().unwrap().connection_error = None;
    fake.0.lock().unwrap().pages.push_back(Err("outage".into()));
    assert!(
        workspace
            .save_source(
                &engine,
                "fake",
                &values(json!({"repositories": ["o/other"]}))
            )
            .is_err()
    );

    assert_eq!(
        workspace.saved_source("fake").unwrap().unwrap().config,
        original
    );
}

#[test]
fn saving_again_replaces_the_configuration_and_unknown_sources_are_rejected() {
    let (_, engine) = setup();
    let (_dir, mut workspace) = workspace();
    workspace
        .save_source(&engine, "fake", &values(json!({"repositories": ["o/a"]})))
        .unwrap();
    workspace
        .save_source(&engine, "fake", &values(json!({"repositories": ["o/b"]})))
        .unwrap();
    assert_eq!(workspace.saved_sources().unwrap().len(), 1);
    assert_eq!(
        workspace.saved_source("fake").unwrap().unwrap().config,
        values(json!({"repositories": ["o/b"]}))
    );
    let error = workspace
        .save_source(&engine, "missing", &ConfigValues::new())
        .unwrap_err();
    assert!(matches!(
        error,
        Error::Source(SourceError::UnknownProvider(_))
    ));
}

#[test]
fn saved_configuration_is_exported_and_survives_backup_and_restore() {
    let (_, engine) = setup();
    let (dir, mut workspace) = workspace();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    workspace
        .save_source(&engine, "fake", &values(json!({"repositories": ["o/a"]})))
        .unwrap();
    let exported = workspace.export().unwrap();
    assert_eq!(exported["source_configurations"][0]["provider"], "fake");
    workspace.backup(&backup).unwrap();
    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert!(workspace.saved_source("fake").unwrap().is_some());
}

#[test]
fn version_twenty_workspaces_gain_the_source_table_on_open() {
    let (_, engine) = setup();
    let (dir, mut workspace) = workspace();
    let path = dir.path().join("workspace.sqlite3");
    let ticket = workspace.create_ticket("Keep me").unwrap();
    drop(workspace);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE source_configurations; PRAGMA user_version = 20;")
        .unwrap();
    drop(db);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().title,
        "Keep me"
    );
    workspace
        .save_source(&engine, "fake", &values(json!({"repositories": ["o/a"]})))
        .unwrap();
    assert_eq!(workspace.saved_sources().unwrap().len(), 1);
}
