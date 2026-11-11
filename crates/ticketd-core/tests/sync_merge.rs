use std::collections::BTreeSet;
use ticketd_core::sync::merge::{BlockedBy, Conflict, Field, Fields, loop_edges, merge};

fn value(text: &str) -> Field {
    Field::Value(text.into())
}

fn set(items: &[&str]) -> Field {
    Field::Set(items.iter().map(|item| item.to_string()).collect())
}

fn record(fields: &[(&str, Field)]) -> Fields {
    fields
        .iter()
        .map(|(name, field)| (name.to_string(), field.clone()))
        .collect()
}

#[test]
fn fields_changed_on_different_sides_combine_without_review() {
    let base = record(&[("title", value("Login")), ("status", value("todo"))]);
    let local = record(&[("title", value("Fix login")), ("status", value("todo"))]);
    let remote = record(&[("title", value("Login")), ("status", value("done"))]);

    let merged = merge(&base, &local, &remote);

    assert_eq!(
        merged.fields,
        record(&[("title", value("Fix login")), ("status", value("done"))])
    );
    assert_eq!(merged.conflicts, []);
    // The other device, seeing the same two edits the other way round, agrees.
    assert_eq!(merge(&base, &remote, &local), merged);
}

#[test]
fn the_same_field_changed_differently_keeps_local_and_reports_both_values() {
    let base = record(&[("body", value("old")), ("status", value("todo"))]);
    let local = record(&[("body", value("mine")), ("status", value("todo"))]);
    let remote = record(&[("body", value("theirs")), ("status", value("done"))]);

    let merged = merge(&base, &local, &remote);

    assert_eq!(
        merged.fields,
        record(&[("body", value("mine")), ("status", value("done"))])
    );
    assert_eq!(
        merged.conflicts,
        [Conflict {
            field: "body".into(),
            base: Some(value("old")),
            local: Some(value("mine")),
            remote: Some(value("theirs")),
        }]
    );
}

#[test]
fn both_sides_making_the_same_change_is_not_a_conflict() {
    let base = record(&[("title", value("a"))]);
    let both = record(&[("title", value("b"))]);
    let merged = merge(&base, &both, &both);
    assert_eq!(merged.fields, both);
    assert_eq!(merged.conflicts, []);
}

#[test]
fn setting_and_clearing_a_field_merge_like_any_other_change() {
    let base = record(&[("parent", value("p1")), ("title", value("a"))]);
    // Local clears the parent; remote sets a project that was unset.
    let local = record(&[("title", value("a"))]);
    let remote = record(&[
        ("parent", value("p1")),
        ("title", value("a")),
        ("project", value("x")),
    ]);
    let merged = merge(&base, &local, &remote);
    assert_eq!(
        merged.fields,
        record(&[("title", value("a")), ("project", value("x"))])
    );
    assert_eq!(merged.conflicts, []);

    // Clearing against a concurrent change is a conflict that keeps the local side.
    let changed = record(&[("parent", value("p2")), ("title", value("a"))]);
    let merged = merge(&base, &local, &changed);
    assert_eq!(merged.fields, local);
    assert_eq!(
        merged.conflicts,
        [Conflict {
            field: "parent".into(),
            base: Some(value("p1")),
            local: None,
            remote: Some(value("p2")),
        }]
    );
}

#[test]
fn trash_against_a_concurrent_edit_stays_trashed_with_the_edit_kept() {
    let base = record(&[("trashed", value("false")), ("title", value("a"))]);
    let local = record(&[("trashed", value("true")), ("title", value("a"))]);
    let remote = record(&[("trashed", value("false")), ("title", value("b"))]);
    let expected = record(&[("trashed", value("true")), ("title", value("b"))]);
    assert_eq!(merge(&base, &local, &remote).fields, expected);
    assert_eq!(merge(&base, &remote, &local).fields, expected);
}

#[test]
fn sets_combine_additions_and_removals_from_both_sides() {
    let base = record(&[("tags", set(&["a", "b", "c"]))]);
    let local = record(&[("tags", set(&["a", "c", "x"]))]); // -b +x
    let remote = record(&[("tags", set(&["a", "b", "y"]))]); // -c +y
    let expected = record(&[("tags", set(&["a", "x", "y"]))]);

    let merged = merge(&base, &local, &remote);
    assert_eq!(merged.fields, expected);
    assert_eq!(merged.conflicts, []);
    assert_eq!(merge(&base, &remote, &local).fields, expected);
}

#[test]
fn an_addition_wins_over_a_concurrent_removal() {
    // One side removed "a"; the other kept it and added "new", or swapped it for "b".
    let base = record(&[("tags", set(&["a"]))]);
    let removed = record(&[("tags", set(&[]))]);
    let swapped = record(&[("tags", set(&["b"]))]);
    assert_eq!(
        merge(&base, &removed, &swapped).fields,
        record(&[("tags", set(&["b"]))])
    );
    let added = record(&[("tags", set(&["a", "new"]))]);
    let expected = record(&[("tags", set(&["new"]))]);
    assert_eq!(merge(&base, &removed, &added).fields, expected);
    assert_eq!(merge(&base, &added, &removed).fields, expected);
}

#[test]
fn a_set_first_seen_on_both_sides_is_their_union() {
    let base = Fields::new();
    let local = record(&[("tags", set(&["a"]))]);
    let remote = record(&[("tags", set(&["b"]))]);
    let merged = merge(&base, &local, &remote);
    assert_eq!(merged.fields, record(&[("tags", set(&["a", "b"]))]));
    assert_eq!(merged.conflicts, []);
}

#[test]
fn a_record_created_on_both_sides_conflicts_only_where_it_differs() {
    let local = record(&[("title", value("a")), ("status", value("todo"))]);
    let remote = record(&[("title", value("b")), ("status", value("todo"))]);
    let merged = merge(&Fields::new(), &local, &remote);
    assert_eq!(merged.fields, local);
    let fields: Vec<&str> = merged.conflicts.iter().map(|c| c.field.as_str()).collect();
    assert_eq!(fields, ["title"]);
}

#[test]
fn conflicts_are_listed_in_field_name_order() {
    let base = record(&[("b", value("0")), ("a", value("0"))]);
    let local = record(&[("b", value("1")), ("a", value("1"))]);
    let remote = record(&[("b", value("2")), ("a", value("2"))]);
    let merged = merge(&base, &local, &remote);
    let fields: Vec<&str> = merged.conflicts.iter().map(|c| c.field.as_str()).collect();
    assert_eq!(fields, ["a", "b"]);
}

fn edge(order: &str, blocked: &str, blocker: &str) -> BlockedBy {
    BlockedBy {
        order: order.into(),
        blocked: blocked.into(),
        blocker: blocker.into(),
    }
}

/// Every ordering of a small edge list.
fn orderings(edges: &[BlockedBy]) -> Vec<Vec<BlockedBy>> {
    if edges.len() <= 1 {
        return vec![edges.to_vec()];
    }
    let mut all = Vec::new();
    for index in 0..edges.len() {
        let mut rest = edges.to_vec();
        let first = rest.remove(index);
        for mut tail in orderings(&rest) {
            tail.insert(0, first.clone());
            all.push(tail);
        }
    }
    all
}

#[test]
fn edges_without_a_loop_are_all_kept() {
    let edges = [
        edge("1", "a", "b"),
        edge("2", "b", "c"),
        edge("3", "a", "c"),
        edge("4", "d", "c"),
    ];
    assert_eq!(loop_edges(&edges), []);
    assert_eq!(loop_edges(&[]), []);
}

#[test]
fn the_later_edge_of_a_loop_is_dropped_whatever_order_edges_arrive_in() {
    // Two devices each added one half of a two-ticket loop.
    let first = edge("2026-01-01", "a", "b");
    let second = edge("2026-01-02", "b", "a");
    assert_eq!(
        loop_edges(&[first.clone(), second.clone()]),
        std::slice::from_ref(&second)
    );
    assert_eq!(loop_edges(&[second.clone(), first]), [second]);

    // A longer loop, with an unrelated edge, in every arrival order.
    let edges = [
        edge("1", "a", "b"),
        edge("2", "b", "c"),
        edge("3", "x", "a"),
        edge("4", "c", "a"),
    ];
    for ordering in orderings(&edges) {
        assert_eq!(loop_edges(&ordering), [edge("4", "c", "a")]);
    }
}

#[test]
fn edges_created_at_the_same_moment_are_ordered_by_their_tickets() {
    let edges = [edge("t", "a", "b"), edge("t", "b", "a")];
    for ordering in orderings(&edges) {
        assert_eq!(loop_edges(&ordering), [edge("t", "b", "a")]);
    }
}

#[test]
fn overlapping_loops_drop_the_same_edges_in_every_arrival_order() {
    let edges = [
        edge("1", "a", "b"),
        edge("2", "b", "c"),
        edge("3", "c", "a"), // closes a-b-c
        edge("4", "c", "d"),
        edge("5", "d", "b"), // closes b-c-d
        edge("6", "e", "e"), // blocks itself
    ];
    let expected = [
        edge("3", "c", "a"),
        edge("5", "d", "b"),
        edge("6", "e", "e"),
    ];
    for ordering in orderings(&edges) {
        assert_eq!(loop_edges(&ordering), expected);
        // What remains has no loop left to drop.
        let kept: Vec<BlockedBy> = ordering
            .into_iter()
            .filter(|edge| !expected.contains(edge))
            .collect();
        assert_eq!(loop_edges(&kept), []);
    }
}

#[test]
fn dropping_an_edge_can_spare_a_later_one() {
    // "2" is dropped, so "4" no longer closes a loop through it.
    let edges = [
        edge("1", "a", "b"),
        edge("2", "b", "a"),
        edge("3", "c", "b"),
        edge("4", "a", "c"),
    ];
    for ordering in orderings(&edges) {
        assert_eq!(loop_edges(&ordering), [edge("2", "b", "a")]);
    }
}

#[test]
fn a_set_changed_against_a_plain_value_is_reviewed_like_any_field() {
    let base = record(&[("tags", set(&["a"]))]);
    let local = record(&[("tags", set(&["a", "b"]))]);
    let remote = record(&[("tags", value("broken"))]);
    let merged = merge(&base, &local, &remote);
    assert_eq!(merged.fields, local);
    assert_eq!(merged.conflicts.len(), 1);
    let _: BTreeSet<String> = BTreeSet::new();
}
