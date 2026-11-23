//! Source configuration through the workspace workflow boundary, using a
//! controllable fake connector instead of any provider transport.
// Clippy exempts #[test] functions but not the fake connector and fixture helpers they
// share; those unwrap so a broken setup fails the test loudly.
#![allow(clippy::unwrap_used)]

#[path = "support/old_workspace.rs"]
mod old_workspace;

#[path = "support/fake_source.rs"]
mod fake_source;

use std::ops::ControlFlow;

use serde_json::{Value, json};
use ticketd_core::{
    self, Error, Workspace,
    source::{CONTRACT_VERSION, ConfigValues, Engine, ExternalIssue, SourceError},
};

use fake_source::{FakeSource, discovery_page};

fn issue(id: u64) -> ExternalIssue {
    let mut issue = fake_source::issue(id, &format!("Issue {id}"));
    issue.body = "private description".into();
    issue
}

fn values(value: Value) -> ConfigValues {
    value.as_object().unwrap().clone()
}

fn setup() -> (FakeSource, Engine) {
    let fake = FakeSource::default();
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
    let fields: Vec<_> = issues.iter().map(|i| i.field.as_deref().unwrap()).collect();
    assert_eq!(
        fields,
        ["extra", "repositories", "repositories", "assignee"]
    );

    let missing = schema
        .validate(&values(json!({"assignee": "octo"})))
        .unwrap_err();
    assert_eq!(missing[0].message, "are required");

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
fn richer_schema_validates_active_fields_and_never_saves_link_values() {
    let schema: ticketd_core::source::ConfigSchema = serde_json::from_value(json!({
        "fields": [
            {"type": "text", "key": "project", "label": "Project", "show_if": "team",
             "advanced": true, "required": true, "placeholder":"ENG-1", "help":"Enter the project key.",
             "pattern": {"regex": "^ENG-[0-9]+$", "message": "must start with ENG- and end in digits"}},
            {"type": "text", "key": "team", "label": "Team", "show_if": "site"},
            {"type": "text", "key": "site", "label": "Site"},
            {"type": "link", "key": "help", "label": "Set up an account", "url": "https://example.com/setup"}
        ]
    })).unwrap();
    let description = serde_json::to_value(&schema).unwrap();
    assert_eq!(description["fields"][0]["placeholder"], "ENG-1");
    assert_eq!(description["fields"][0]["help"], "Enter the project key.");
    assert_eq!(description["fields"][0]["advanced"], true);
    assert_eq!(description["fields"][3]["url"], "https://example.com/setup");

    let settings = |assignments: &[&str]| {
        schema
            .values_from_assignments(
                &assignments
                    .iter()
                    .map(|entry| (*entry).to_owned())
                    .collect::<Vec<_>>(),
            )
            .unwrap()
    };
    assert!(
        schema
            .validate(&settings(&["team=eng", "project=bad"]))
            .unwrap()
            .is_empty()
    );
    let errors = schema
        .validate(&settings(&["site=example", "team=eng"]))
        .unwrap_err();
    assert_eq!(errors[0].field.as_deref(), Some("project"));
    assert_eq!(errors[0].message, "is required");
    let errors = schema
        .validate(&settings(&["site=example", "team=eng", "project=bad"]))
        .unwrap_err();
    assert_eq!(errors[0].message, "must start with ENG- and end in digits");
    let valid = schema
        .validate(&settings(&["site=example", "team=eng", "project= ENG-1 "]))
        .unwrap();
    assert_eq!(valid["project"], "ENG-1");
    assert!(
        schema
            .values_from_assignments(&["help=https://example.com".into()])
            .is_err()
    );
    assert!(
        schema
            .validate(&values(json!({"help":"https://example.com"})))
            .is_err()
    );
}

#[test]
fn a_declared_secret_is_refused_even_without_a_value() {
    let schema: ticketd_core::source::ConfigSchema = serde_json::from_value(json!({
        "fields": [{"type": "secret", "key": "api_key", "label": "API key"}]
    }))
    .unwrap();
    let errors = schema.validate(&ConfigValues::new()).unwrap_err();
    assert_eq!(errors[0].field.as_deref(), Some("api_key"));
    assert!(
        errors[0]
            .message
            .contains("secret settings are not supported yet")
    );

    let fake = FakeSource::default();
    fake.0.lock().unwrap().extra_fields = schema.fields;
    let mut engine = Engine::new();
    let error = engine.register(Box::new(fake)).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("api_key secret settings are not supported yet")
    );
    assert!(engine.connectors().is_empty());
}

#[test]
fn source_validation_sees_normalized_values_and_prevents_save() {
    use ticketd_core::source::FieldIssue;

    let (fake, engine) = setup();
    let (_dir, mut workspace) = workspace();
    fake.0.lock().unwrap().validate_config = Some(|config| {
        assert_eq!(config["repositories"], json!(["o/r"]));
        vec![
            FieldIssue::for_field("repositories", "must include your project"),
            FieldIssue::for_form("Choose a different account and try again."),
        ]
    });
    let raw = values(json!({"repositories":[" o/r ", "o/r"]}));
    let error = workspace.save_source(&engine, "fake", &raw).unwrap_err();
    let Error::Source(error) = error else {
        panic!("{error}");
    };
    assert_eq!(error.issues()[0].field.as_deref(), Some("repositories"));
    assert_eq!(error.issues()[1].field, None);
    assert!(error.to_string().contains("Choose a different account"));
    assert_eq!(fake.0.lock().unwrap().discover_calls, 0);
    assert!(workspace.saved_source("fake").unwrap().is_none());

    // Signing in is possible while a draft is incomplete.
    assert_eq!(
        engine
            .check_connection("fake", &ConfigValues::new())
            .unwrap()
            .account,
        "octo"
    );
}

#[test]
fn preview_walks_every_page_and_lists_without_importing() {
    let (fake, engine) = setup();
    {
        let mut state = fake.0.lock().unwrap();
        state.pages = vec![
            Ok(discovery_page(vec![issue(1), issue(2)], Some("1".into()))),
            Ok(discovery_page(vec![], Some("2".into()))),
            Ok(discovery_page(vec![issue(2), issue(3)], None)),
        ];
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
    assert_eq!(cursors, [None, Some("1".into()), Some("2".into())]);
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
        state.pages = vec![
            Ok(discovery_page(batch(0), Some("1".into()))),
            Ok(discovery_page(batch(100), Some("2".into()))),
            Ok(discovery_page(batch(200), None)),
        ];
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

    fake.0.lock().unwrap().pages = vec![Err("down".into())];
    assert_eq!(
        engine.preview("fake", &config).unwrap_err().code(),
        "unavailable"
    );

    // The returned continuation must advance on every page of a walk.
    fake.0.lock().unwrap().pages = vec![
        Ok(discovery_page(vec![], Some("1".into()))),
        Ok(discovery_page(vec![], Some("1".into()))),
    ];
    let error = engine.preview("fake", &config).unwrap_err();
    assert_eq!(error.code(), "protocol");
}

#[test]
fn the_engine_visitor_can_stop_early_and_foreign_identities_are_rejected() {
    let (fake, engine) = setup();
    fake.0.lock().unwrap().pages = vec![Ok(discovery_page(
        (1..=5).map(issue).collect(),
        Some("1".into()),
    ))];
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
    fake.0.lock().unwrap().pages = vec![Ok(discovery_page(vec![foreign], None))];
    let error = engine
        .discover("fake", &values(json!({"repositories": ["o/r"]})), |_| {
            ControlFlow::Continue(())
        })
        .unwrap_err();
    assert_eq!(error.code(), "protocol");
}

#[test]
fn a_connector_with_another_contract_version_is_refused() {
    let fake = FakeSource::default();
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
    fake.0.lock().unwrap().pages = vec![Ok(discovery_page(vec![issue(1)], None))];

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
    fake.0.lock().unwrap().pages = vec![Err("outage".into())];
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
fn version_twentyone_workspaces_gain_the_source_table_on_open() {
    let (_, engine) = setup();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 21).unwrap();
    old_workspace::add_ticket(&path, "11111111-1111-4111-8111-111111111111", "Keep me");
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket("T-KQ1").unwrap().title, "Keep me");
    workspace
        .save_source(&engine, "fake", &values(json!({"repositories": ["o/a"]})))
        .unwrap();
    assert_eq!(workspace.saved_sources().unwrap().len(), 1);
}
