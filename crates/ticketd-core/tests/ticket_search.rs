//! Ticket search is a literal substring match, case-insensitive for ASCII letters only,
//! over a ticket's reference, title, body and Activity briefs. A query shorter than three
//! characters matches only the reference and title. Each case below is checked against
//! that rule applied directly to the tickets.
use ticketd_core::{Ticket, TicketFilter, TicketPatch, Workspace};

struct Searched {
    workspace: Workspace,
    _dir: tempfile::TempDir,
}

#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn workspace() -> Searched {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("search.sqlite3")).unwrap();
    let bodies = [
        ("Ship the importer", "Reads the legacy file."),
        ("Review the parser", "Räksmörgås for the gateway team."),
        (
            "Retire the exporter",
            "Uses \"quoted\" words and a*b and [literal] marks.",
        ),
        ("Cache invalidation", "Nothing to see"),
        ("Rewrite AB tests", "Short words: ab, xy."),
        ("Café menu", "CAFÉ in capitals, café in lower case."),
    ];
    for (title, body) in bodies {
        let ticket = workspace.create_ticket(title).unwrap();
        workspace
            .change_ticket(
                &ticket.reference,
                TicketPatch {
                    body: Some(body.into()),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    let tickets = workspace.list_tickets().unwrap();
    let cache = tickets
        .iter()
        .find(|t| t.title == "Cache invalidation")
        .unwrap();
    workspace
        .add_activity(&cache.reference, "Found the stale TIMELINE entry", None)
        .unwrap();
    let trashed = workspace.create_ticket("Importer in the trash").unwrap();
    workspace
        .set_trashed(&trashed.reference, true, None)
        .unwrap();
    Searched {
        workspace,
        _dir: dir,
    }
}

/// The references of tickets out of the Trash that the rule finds, newest first.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn expected(workspace: &Workspace, query: &str, reference: bool) -> Vec<String> {
    let needle = query.to_ascii_lowercase();
    let has = |text: &str| text.to_ascii_lowercase().contains(&needle);
    let long = query.chars().count() >= 3;
    workspace
        .list_tickets()
        .unwrap()
        .into_iter()
        .filter(|ticket: &Ticket| {
            (reference && has(&ticket.reference))
                || has(&ticket.title)
                || (long
                    && (has(&ticket.body)
                        || workspace
                            .activities(&ticket.reference, 100, 0)
                            .unwrap()
                            .iter()
                            .any(|activity| has(&activity.brief))))
        })
        .map(|ticket| ticket.reference)
        .collect()
}

fn references(tickets: Vec<Ticket>) -> Vec<String> {
    tickets.into_iter().map(|ticket| ticket.reference).collect()
}

const QUERIES: [&str; 17] = [
    "importer",
    "IMPORTER",
    "the",
    "räksmörgås",
    "RÄKSMÖRGÅS",
    "räKSMörg",
    "café",
    "CAFÉ",
    "\"quoted\"",
    "a*b",
    "[literal]",
    "timeline",
    "stale timeline",
    "ab",
    "xy",
    "Ca",
    "zzz",
];

#[test]
fn search_finds_what_a_literal_ascii_case_insensitive_match_finds() {
    let Searched { workspace, .. } = workspace();
    for query in QUERIES {
        let mut found = references(
            workspace
                .search_tickets(query, None, false, 100, 0)
                .unwrap(),
        );
        let mut wanted = expected(&workspace, query, true);
        // The order puts reference matches first; which tickets match is checked here.
        found.sort();
        wanted.sort();
        assert_eq!(found, wanted, "query {query:?}");
    }
}

#[test]
fn the_list_filter_finds_what_the_same_match_finds_without_references() {
    let Searched { workspace, .. } = workspace();
    for query in QUERIES {
        let filter = TicketFilter {
            query: query.into(),
            limit: 100,
            ..Default::default()
        };
        let found = references(workspace.find_tickets(&filter).unwrap());
        assert_eq!(found, expected(&workspace, query, false), "query {query:?}");
        let counted = workspace.count_tickets(&filter).unwrap();
        assert_eq!(counted.total() as usize, found.len(), "query {query:?}");
    }
}

#[test]
fn search_follows_changes_to_bodies_and_briefs() {
    let Searched { mut workspace, .. } = workspace();
    let first = workspace.create_ticket("Plain").unwrap();
    assert!(
        workspace
            .search_tickets("needle", None, false, 50, 0)
            .unwrap()
            .is_empty()
    );
    workspace
        .change_ticket(
            &first.reference,
            TicketPatch {
                body: Some("A needle here".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        references(
            workspace
                .search_tickets("needle", None, false, 50, 0)
                .unwrap()
        ),
        vec![first.reference.clone()]
    );
    let activity = workspace
        .add_activity(&first.reference, "Thread found", None)
        .unwrap();
    workspace
        .change_ticket(
            &first.reference,
            TicketPatch {
                body: Some("Gone".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        workspace
            .search_tickets("needle", None, false, 50, 0)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        references(
            workspace
                .search_tickets("thread", None, false, 50, 0)
                .unwrap()
        ),
        vec![first.reference.clone()]
    );
    workspace
        .delete_activity(&first.reference, &activity.id)
        .unwrap();
    assert!(
        workspace
            .search_tickets("thread", None, false, 50, 0)
            .unwrap()
            .is_empty()
    );
}
