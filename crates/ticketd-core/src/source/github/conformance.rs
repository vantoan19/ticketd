//! GitHub's driver translates the shared scenarios into HTTP fixture responses.

use super::{
    API, Cursor, Fixture as TransportFixture, TOKEN, TransportError, config, connector, created,
    gh_comment, issue, json, ok, ok_with, status,
};
use crate::source::{
    ExternalIdentity, ExternalRef, PublicationSearch, PublishRequest,
    conformance::{
        self, BODY_MATCH, ClosureProbes, CommentProbe, Driver, FIRST, Fixture, LAST,
        PublishFailure, RECENT, REOBSERVED, TITLE_MATCH,
    },
};
use std::sync::Arc;

struct GitHubDriver;

impl Driver for GitHubDriver {
    fn discovery() -> Fixture<String> {
        let transport = Arc::new(TransportFixture::default());
        transport.respond(&format!("{API}/user"), ok(json!({"login": "octo"})));
        let first_url = format!("{API}/repos/o/r/issues?state=open&per_page=100");
        let empty_url = format!("{API}/repos/o/r/issues?page=2");
        let last_url = format!("{API}/repos/o/r/issues?page=3");
        let mut first = issue(1001, 1, "o/r");
        first["title"] = json!(FIRST);
        let mut reobserved = issue(1001, 11, "o/moved");
        reobserved["title"] = json!(REOBSERVED);
        let mut last = issue(1002, 2, "o/r");
        last["title"] = json!(LAST);
        let mut pull_request = issue(1003, 3, "o/r");
        pull_request["pull_request"] = json!({});
        for _ in 0..2 {
            transport.respond(&first_url, next_page(json!([first]), &empty_url));
            transport.respond(&empty_url, next_page(json!([pull_request]), &last_url));
            transport.respond(&last_url, ok(json!([reobserved, last])));
        }
        transport.respond(&format!("{API}/repos/o/r/issues/1"), ok(first));
        transport.respond(&format!("{API}/repos/o/r/issues/2"), ok(last));
        let cursor = Cursor {
            repository: 1,
            next: None,
        }
        .encode();
        github_fixture(&transport, cursor)
    }

    fn invalid_configuration() -> Fixture<()> {
        let transport = Arc::new(TransportFixture::default());
        Fixture {
            config: config(json!({"repositories": ["not a repository"]})),
            ..github_fixture(&transport, ())
        }
    }

    fn closures() -> Fixture<ClosureProbes> {
        let transport = Arc::new(TransportFixture::default());
        let add = |number, reason| {
            let id = 1000 + number;
            let mut value = issue(id, number, "o/r");
            value["state"] = json!("closed");
            value["state_reason"] = reason;
            transport.respond(&format!("{API}/repos/o/r/issues/{number}"), ok(value));
            reference(number, id)
        };
        let mut open = issue(1004, 4, "o/r");
        open["state_reason"] = json!("completed");
        transport.respond(&format!("{API}/repos/o/r/issues/4"), ok(open));
        transport.respond(
            &format!("{API}/repos/o/r/issues/5"),
            status(404, json!({}), &[]),
        );
        transport.respond(
            &format!("{API}/repos/o/r/issues/6"),
            status(503, json!({}), &[]),
        );
        let probes = ClosureProbes {
            open: reference(4, 1004),
            completed: add(1, json!("completed")),
            no_reason: add(2, json!(null)),
            unknown_reason: add(3, json!("unmapped_reason")),
            missing: reference(5, 1005),
            unreadable: reference(6, 1006),
        };
        github_fixture(&transport, probes)
    }

    fn comments() -> Fixture<CommentProbe> {
        let transport = Arc::new(TransportFixture::default());
        let comments = format!("{API}/repos/o/r/issues/1/comments?per_page=100");
        let events = format!("{API}/repos/o/r/issues/1/events?per_page=100");
        let at = "2026-01-02T00:00:00Z";
        let second = gh_comment(102, Some("bob"), "second", at);
        transport.respond(
            &comments,
            ok(json!([
                gh_comment(101, Some("alice"), "original", at),
                second,
            ])),
        );
        transport.respond(&events, ok(json!([])));
        let remote = transport.clone();
        let edit = Box::new(move || {
            let mut edited = gh_comment(101, Some("alice"), "edited", at);
            edited["updated_at"] = json!("2026-01-03T00:00:00Z");
            remote.respond(&comments, ok(json!([second, edited])));
            remote.respond(&events, ok(json!([])));
        });
        github_fixture(
            &transport,
            CommentProbe {
                reference: reference(1, 1001),
                edit,
            },
        )
    }

    fn publish_failure(failure: PublishFailure) -> Fixture<PublishRequest> {
        let transport = Arc::new(TransportFixture::default());
        let response = match failure {
            PublishFailure::Refused => status(422, json!({"message": "Creation refused"}), &[]),
            PublishFailure::NotSent => Err(TransportError {
                message: "connection refused".into(),
                before_send: true,
            }),
            PublishFailure::ResponseLost => Err("connection reset after sending issue".into()),
        };
        transport.respond(&format!("{API}/repos/o/r/issues"), response);
        github_fixture(&transport, conformance::publication_search().request)
    }

    fn publication_search(complete: bool) -> Fixture<PublicationSearch> {
        let transport = Arc::new(TransportFixture::default());
        // The fixture already has tracker time from the authenticated check at dispatch.
        let first_url = format!(
            "{API}/repos/o/r/issues?state=all&sort=created&direction=desc&per_page=100&since=2026-01-01T00%3A00%3A00Z"
        );
        let second_url = format!("{API}/repos/o/r/issues?page=2");
        let mut search = conformance::publication_search();
        search.tracker_since = Some(conformance::SEARCH_SINCE.into());
        if complete {
            let mut title_match = issue(1001, 1, "o/r");
            title_match["title"] = json!(TITLE_MATCH);
            let mut body_match = issue(1002, 2, "o/r");
            body_match["title"] = json!(BODY_MATCH);
            body_match["body"] = json!(search.request.body);
            let mut recent = issue(1003, 3, "o/r");
            recent["title"] = json!(RECENT);
            recent["user"]["login"] = json!("octo");
            let mut old = created(issue(1005, 5, "o/r"), "2025-12-31T00:00:00Z");
            old["title"] = json!(TITLE_MATCH);
            transport.respond(
                &first_url,
                next_page(
                    json!([title_match, recent, issue(1004, 4, "o/r")]),
                    &second_url,
                ),
            );
            transport.respond(&second_url, ok(json!([body_match, old])));
        } else {
            transport.respond(&first_url, next_page(json!([]), &second_url));
            for number in 2..=super::SEARCH_PAGES {
                let url = format!("{API}/repos/o/r/issues?page={number}");
                let next = format!("{API}/repos/o/r/issues?page={}", number + 1);
                transport.respond(&url, next_page(json!([]), &next));
            }
        }
        github_fixture(&transport, search)
    }
}

fn github_fixture<T>(transport: &Arc<TransportFixture>, data: T) -> Fixture<T> {
    Fixture {
        connector: Box::new(connector(transport, Some(TOKEN))),
        config: config(json!({"repositories": ["o/r"]})),
        data,
    }
}

fn reference(number: u64, id: u64) -> ExternalRef {
    ExternalRef {
        identity: ExternalIdentity {
            provider: "github".into(),
            id: format!("@api.example.test:{id}"),
        },
        locator: format!("o/r#{number}"),
        partition: "@api.example.test/o/r".into(),
    }
}

fn next_page(body: serde_json::Value, next: &str) -> Result<super::HttpResponse, TransportError> {
    ok_with(body, &[("link", &format!("<{next}>; rel=\"next\""))])
}

conformance::contract_tests!(checks, super::GitHubDriver);
