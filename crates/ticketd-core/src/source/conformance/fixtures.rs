//! One suite for the fake and every ticket source adapter. The driver controls
//! what the provider reports. Each check observes the public connector contract
//! or, for configuration and de-duplication, the Engine that enforces it.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::ClosureProbes;
use std::{collections::BTreeMap, ops::ControlFlow};

use serde_json::json;

use super::super::{
    Capability, ConfigValues, Connector, Conversation, DiscoveryRequest, Engine, ErrorClass,
    ExternalComment, ExternalIssue, ExternalRef, ExternalState, PublicationSearch, PublishRequest,
    StateCategory,
};

use crate as ticketd_core;

#[path = "../../../tests/support/fake_source.rs"]
mod fake_source;
use fake_source::{FakeSource, PublishMode, discovery_page, issue, issue_in};

pub(in crate::source) const FIRST: &str = "First issue";
pub(in crate::source) const REOBSERVED: &str = "First issue after a move";
pub(in crate::source) const LAST: &str = "Issue after the empty page";
pub(in crate::source) const TITLE_MATCH: &str = "Conformance publication";
pub(in crate::source) const BODY_MATCH: &str = "Issue originally sent as Conformance publication";
pub(in crate::source) const RECENT: &str = "Recent issue with different content";
pub(in crate::source) const SEARCH_SINCE: &str = "2026-01-01T00:00:00Z";

pub(in crate::source) struct Fixture<T> {
    pub connector: Box<dyn Connector>,
    pub config: ConfigValues,
    pub data: T,
}

impl<T> Fixture<T> {
    fn engine(self) -> (Engine, String, ConfigValues) {
        let provider = self.connector.descriptor().provider;
        let mut engine = Engine::new();
        engine.register(self.connector).unwrap();
        (engine, provider, self.config)
    }

    fn require(&self, capability: Capability) {
        assert!(
            self.connector
                .descriptor()
                .capabilities
                .contains(&capability),
            "fixture requires {capability:?}"
        );
    }
}

pub(in crate::source) struct CommentProbe {
    pub reference: ExternalRef,
    pub edit: Box<dyn FnOnce()>,
}

#[derive(Clone, Copy, Debug)]
pub(in crate::source) enum PublishFailure {
    Refused,
    NotSent,
    ResponseLost,
}

pub(in crate::source) trait Driver {
    /// Three pages, containing FIRST, an empty continuation, then the same
    /// identity with new display data (REOBSERVED) and LAST. The data is a valid
    /// opaque cursor beyond those pages. Discovery must be readable twice.
    fn discovery() -> Fixture<String>;
    fn invalid_configuration() -> Fixture<()>;
    fn closures() -> Fixture<ClosureProbes>;
    /// Two comments, "original" and "second". The edit changes "original" to
    /// "edited", preserving the source identity.
    fn comments() -> Fixture<CommentProbe>;
    fn publish_failure(failure: PublishFailure) -> Fixture<PublishRequest>;
    /// A title match (TITLE_MATCH), a description match (BODY_MATCH), a recent
    /// issue of the signed-in account (RECENT), and issues outside the window
    /// or belonging to someone else. Incomplete searches do not cover the window.
    fn publication_search(complete: bool) -> Fixture<PublicationSearch>;

    /// Any omitted check must give a nonempty reason. The two fixture drivers
    /// exercise all checks.
    fn skip_reason(_check: &str) -> Option<&'static str> {
        None
    }
}

pub(in crate::source) fn run_check(name: &str, skip_reason: Option<&str>, check: impl FnOnce()) {
    if let Some(reason) = skip_reason {
        assert!(
            !reason.trim().is_empty(),
            "{name}: a skipped check needs a reason"
        );
        tracing::info!(check = name, reason, "conformance check skipped");
    } else {
        check();
    }
}

pub(in crate::source) fn paging_keeps_an_empty_continuation<D: Driver>() {
    let Fixture {
        connector, config, ..
    } = D::discovery();
    let page = |cursor| {
        connector
            .discover(DiscoveryRequest {
                config: &config,
                cursor,
                page_size: 100,
            })
            .unwrap()
    };

    let first = page(None);
    assert_eq!(titles(&first.issues), [FIRST]);
    let empty = page(Some(
        first.next_cursor.as_deref().expect("first continuation"),
    ));
    assert!(empty.issues.is_empty(), "second page contains no issues");
    let last = page(Some(
        empty
            .next_cursor
            .as_deref()
            .expect("empty page continuation"),
    ));
    assert_eq!(titles(&last.issues), [REOBSERVED, LAST]);
    assert_eq!(last.next_cursor, None);
}

pub(in crate::source) fn a_cursor_past_the_end_returns_no_issues_or_continuation<D: Driver>() {
    let Fixture {
        connector,
        config,
        data: past_end,
    } = D::discovery();
    super::check_past_end(connector.as_ref(), &config, &past_end).unwrap();
}

pub(in crate::source) fn discovery_delivers_each_identity_once<D: Driver>() {
    let (engine, provider, config) = D::discovery().engine();
    let issues = discover_all(&engine, &provider, &config);
    assert_eq!(titles(&issues), [FIRST, LAST]);
}

pub(in crate::source) fn issue_ids_are_stable_across_runs_and_fetch<D: Driver>() {
    let (engine, provider, config) = D::discovery().engine();
    let first_run = discover_all(&engine, &provider, &config);
    let second_run = discover_all(&engine, &provider, &config);
    assert_eq!(titles(&first_run), [FIRST, LAST]);
    assert_eq!(titles(&second_run), [FIRST, LAST]);

    for (first, second) in first_run.iter().zip(second_run) {
        let identity = &first.reference.identity;
        super::verify_identity(&provider, identity).unwrap();
        assert_eq!(
            *identity, second.reference.identity,
            "id changed for {}",
            first.title
        );
        let fetched = engine.fetch(&provider, &config, &first.reference).unwrap();
        assert_eq!(
            *identity, fetched.reference.identity,
            "fetch changed the id"
        );
        assert_eq!(fetched.title, first.title);
    }
}

pub(in crate::source) fn discovered_refs_name_the_parts_returned_by_check<D: Driver>() {
    let fixture = D::discovery();
    let checked = fixture.connector.check_connection(&fixture.config).unwrap();
    assert_eq!(checked.connection.account, "octo");
    assert_eq!(checked.derived.partitions, ["o/r"]);
    assert_eq!(checked.derived.publication.destinations, ["o/r"]);
    let first = fixture
        .connector
        .discover(DiscoveryRequest {
            config: &fixture.config,
            cursor: None,
            page_size: 100,
        })
        .unwrap();
    assert_eq!(first.issues[0].reference.partition, "o/r");
}

pub(in crate::source) fn invalid_configuration_is_a_configuration_error<D: Driver>() {
    let (engine, provider, invalid) = D::invalid_configuration().engine();
    let error = engine
        .discover(&provider, &invalid, |_| ControlFlow::Continue(()))
        .unwrap_err();
    assert_eq!(error.class(), ErrorClass::Config, "{error}");
    assert_eq!(error.code(), "invalid_configuration");
    assert!(!error.issues().is_empty(), "{error}");
}

pub(in crate::source) fn closure_requires_positive_tracker_state<D: Driver>() {
    let Fixture {
        connector,
        config,
        data,
    } = D::closures();
    super::check_closures(connector.as_ref(), &config, &data).unwrap();
}

pub(in crate::source) fn comment_ids_survive_repeated_reads_and_edits<D: Driver>() {
    let fixture = D::comments();
    fixture.require(Capability::Comments);
    let Fixture {
        connector,
        config,
        data,
    } = fixture;
    let read = || {
        let comments = connector
            .conversation(&config, &data.reference)
            .unwrap()
            .comments;
        assert_eq!(comments.len(), 2);
        comments
            .into_iter()
            .map(|comment| (comment.body, comment.id))
            .collect::<BTreeMap<_, _>>()
    };

    let first = read();
    assert!(!first["original"].trim().is_empty());
    assert!(!first["second"].trim().is_empty());
    assert_ne!(first["original"], first["second"]);

    (data.edit)();
    let second = read();
    assert_eq!(first["original"], second["edited"]);
    assert_eq!(first["second"], second["second"]);
}

pub(in crate::source) fn failed_publication_classifies_creation_honestly<D: Driver>() {
    for (failure, class, ruled_out) in [
        (PublishFailure::Refused, ErrorClass::Auth, true),
        (PublishFailure::NotSent, ErrorClass::Transient, true),
        (PublishFailure::ResponseLost, ErrorClass::Transient, false),
    ] {
        let fixture = D::publish_failure(failure);
        fixture.require(Capability::Publish);
        let error = fixture
            .connector
            .publication()
            .unwrap()
            .publish(&fixture.config, &fixture.data)
            .unwrap_err();
        assert_eq!(error.class(), class, "{failure:?}: {error}");
        assert_eq!(
            error.ruled_out_creation(),
            ruled_out,
            "{failure:?}: {error}"
        );
    }
}

pub(in crate::source) fn uncertain_search_distinguishes_matches_recent_and_incomplete<D: Driver>() {
    let fixture = D::publication_search(true);
    fixture.require(Capability::Publish);
    let result = fixture
        .connector
        .publication()
        .unwrap()
        .find_published(&fixture.config, &fixture.data)
        .unwrap();
    assert!(result.complete, "the source read the whole window");
    let mut matched = titles(&result.matches);
    matched.sort_unstable();
    assert_eq!(matched, [TITLE_MATCH, BODY_MATCH]);
    assert_eq!(titles(&result.recent), [RECENT]);

    let fixture = D::publication_search(false);
    let result = fixture
        .connector
        .publication()
        .unwrap()
        .find_published(&fixture.config, &fixture.data)
        .unwrap();
    assert!(
        !result.complete,
        "a partial search cannot rule out creation"
    );
    assert!(
        result.matches.is_empty(),
        "this fixture finds no matches in the visible pages"
    );
}

fn titles(issues: &[ExternalIssue]) -> Vec<&str> {
    issues.iter().map(|issue| issue.title.as_str()).collect()
}

fn discover_all(engine: &Engine, provider: &str, config: &ConfigValues) -> Vec<ExternalIssue> {
    let mut issues = Vec::new();
    let summary = engine
        .discover(provider, config, |issue| {
            issues.push(issue);
            ControlFlow::Continue(())
        })
        .unwrap();
    assert!(summary.complete);
    assert!(summary.skipped.is_empty());
    issues
}

macro_rules! contract_checks {
    ($driver:ty; $($check:ident),+ $(,)?) => {$(
        #[test]
        fn $check() {
            conformance::run_check(
                stringify!($check),
                <$driver as Driver>::skip_reason(stringify!($check)),
                conformance::$check::<$driver>,
            );
        }
    )+};
}
pub(in crate::source) use contract_checks;

macro_rules! contract_tests {
    ($module:ident, $driver:ty) => {
        mod $module {
            use crate::source::conformance::{self, Driver};

            $crate::source::conformance::contract_checks!(
                $driver;
                paging_keeps_an_empty_continuation,
                a_cursor_past_the_end_returns_no_issues_or_continuation,
                discovery_delivers_each_identity_once,
                issue_ids_are_stable_across_runs_and_fetch,
                invalid_configuration_is_a_configuration_error,
                discovered_refs_name_the_parts_returned_by_check,
                closure_requires_positive_tracker_state,
                comment_ids_survive_repeated_reads_and_edits,
                failed_publication_classifies_creation_honestly,
                uncertain_search_distinguishes_matches_recent_and_incomplete,
            );
        }
    };
}
pub(in crate::source) use contract_tests;

struct FakeDriver;

impl Driver for FakeDriver {
    fn discovery() -> Fixture<String> {
        let fake = FakeSource::default();
        let first = issue(1, FIRST);
        let reobserved = issue_in("o/moved", 1, REOBSERVED);
        let last = issue(2, LAST);
        let mut remote = fake.0.lock().unwrap();
        remote
            .issues
            .extend([(1, first.clone()), (2, last.clone())]);
        remote.pages = vec![
            Ok(discovery_page(vec![first], Some("1".into()))),
            Ok(discovery_page(Vec::new(), Some("2".into()))),
            Ok(discovery_page(vec![reobserved, last], None)),
        ];
        drop(remote);
        fake_fixture(fake, "3".into())
    }

    fn invalid_configuration() -> Fixture<()> {
        Fixture {
            config: ConfigValues::new(),
            ..fake_fixture(FakeSource::default(), ())
        }
    }

    fn closures() -> Fixture<ClosureProbes> {
        let fake = FakeSource::default();
        let add = |id, category, name| {
            let mut issue = issue(id, "Issue state probe");
            issue.state = ExternalState::named(category, name);
            let reference = issue.reference.clone();
            fake.0.lock().unwrap().issues.insert(id, issue);
            reference
        };
        let data = ClosureProbes {
            open: add(1, StateCategory::Open, "Done"),
            completed: add(2, StateCategory::Completed, "Released"),
            no_reason: add(3, StateCategory::Unknown, "Closed"),
            unknown_reason: add(4, StateCategory::Unknown, "Completed"),
            missing: issue(5, "Missing").reference,
            unreadable: issue(6, "Unreadable").reference,
        };
        fake.0.lock().unwrap().broken.push(6);
        fake_fixture(fake, data)
    }

    fn comments() -> Fixture<CommentProbe> {
        let fake = FakeSource::default();
        let mut first = comment("101", "original");
        let second = comment("102", "second");
        fake.0.lock().unwrap().conversations.insert(
            1,
            Conversation {
                comments: vec![first.clone(), second.clone()],
                events: vec![],
            },
        );
        let remote = fake.0.clone();
        let edit = Box::new(move || {
            first.body = "edited".into();
            remote.lock().unwrap().conversations.insert(
                1,
                Conversation {
                    comments: vec![second, first],
                    events: vec![],
                },
            );
        });
        fake_fixture(
            fake,
            CommentProbe {
                reference: issue(1, FIRST).reference,
                edit,
            },
        )
    }

    fn publish_failure(failure: PublishFailure) -> Fixture<PublishRequest> {
        let fake = FakeSource::default();
        fake.0.lock().unwrap().publish_mode = match failure {
            PublishFailure::Refused => PublishMode::Refuse,
            PublishFailure::NotSent => PublishMode::NotSent,
            PublishFailure::ResponseLost => PublishMode::LoseResponse,
        };
        fake_fixture(fake, publication_search().request)
    }

    fn publication_search(complete: bool) -> Fixture<PublicationSearch> {
        let fake = FakeSource::default();
        let mut remote = fake.0.lock().unwrap();
        remote.search_incomplete = !complete;
        if complete {
            let mut body_match = issue(2, BODY_MATCH);
            body_match.body = publication_search().request.body;
            let mut edited = issue(3, RECENT);
            edited.author = Some("octo".into());
            let mut old = issue(5, TITLE_MATCH);
            old.created_at = "2025-12-31T00:00:00Z".into();
            remote.issues.extend([
                (1, issue(1, TITLE_MATCH)),
                (2, body_match),
                (3, edited),
                (4, issue(4, "Other account's issue")),
                (5, old),
            ]);
        }
        drop(remote);
        fake_fixture(fake, publication_search())
    }
}

fn fake_fixture<T>(fake: FakeSource, data: T) -> Fixture<T> {
    Fixture {
        connector: Box::new(fake),
        config: json!({"repositories": ["o/r"]})
            .as_object()
            .unwrap()
            .clone(),
        data,
    }
}

pub(in crate::source) fn publication_search() -> PublicationSearch {
    PublicationSearch {
        request: PublishRequest {
            title: TITLE_MATCH.into(),
            body: "The ticket description as sent.".into(),
            destination: "o/r".into(),
        },
        tracker_since: None,
        account: Some("octo".into()),
        since: SEARCH_SINCE.into(),
    }
}

fn comment(id: &str, body: &str) -> ExternalComment {
    ExternalComment {
        id: id.into(),
        author: "alice".into(),
        body: body.into(),
        url: format!("https://example.test/o/r/issues/1#comment-{id}"),
        created_at: "2026-02-01T00:00:00Z".into(),
        updated_at: "2026-02-01T00:00:00Z".into(),
    }
}

contract_tests!(fake, super::FakeDriver);

#[test]
#[should_panic(expected = "discovery: a skipped check needs a reason")]
fn a_skip_with_a_blank_reason_fails_the_suite() {
    run_check("discovery", Some("   "), || unreachable!());
}
