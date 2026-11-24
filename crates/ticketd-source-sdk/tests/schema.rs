#![allow(clippy::unwrap_used)]

use serde_json::{Value, json};
use ticketd_source_sdk::{ConfigSchema, ConfigValues};

fn schema(fields: Value) -> ConfigSchema {
    serde_json::from_value(json!({ "fields": fields })).unwrap()
}

fn values(value: Value) -> ConfigValues {
    serde_json::from_value(value).unwrap()
}

#[test]
fn definition_rejects_an_invalid_pattern_and_inverted_selection_bounds() {
    let schema = schema(json!([
        {
            "key": "name", "label": "Name", "type": "text",
            "pattern": { "regex": "[", "message": "must match" }
        },
        {
            "key": "teams", "label": "Teams", "type": "multi_select",
            "options": { "source": "dynamic" }, "min_items": 2, "max_items": 1
        },
        {
            "key": "areas", "label": "Areas", "type": "multi_select",
            "options": { "source": "dynamic" }, "min_items": 1, "max_items": 1
        }
    ]));
    let issues = schema.check_definition().unwrap_err();
    assert_eq!(
        issues
            .iter()
            .filter_map(|issue| issue.field.as_deref())
            .collect::<Vec<_>>(),
        ["name", "teams"]
    );
}

#[test]
fn activation_stops_at_a_cycle_and_follows_a_valid_chain() {
    let schema = schema(json!([
        { "key": "one", "label": "One", "type": "text", "show_if": "two" },
        { "key": "two", "label": "Two", "type": "text", "show_if": "one" },
        { "key": "three", "label": "Three", "type": "text", "show_if": "four" },
        { "key": "four", "label": "Four", "type": "text", "show_if": "five" },
        { "key": "five", "label": "Five", "type": "text" }
    ]));
    let fields = values(json!({ "one": "a", "two": "b", "four": "d", "five": "e" }));
    assert!(!schema.is_active(schema.field("one").unwrap(), &fields));
    assert!(schema.is_active(schema.field("three").unwrap(), &fields));
}

#[test]
fn text_fields_accept_one_line_and_reject_embedded_line_breaks() {
    let schema = schema(json!([{ "key": "name", "label": "Name", "type": "text" }]));
    assert_eq!(
        schema
            .validate(&values(json!({ "name": "  a single line  " })))
            .unwrap(),
        values(json!({ "name": "a single line" }))
    );
    assert!(
        schema
            .validate(&values(json!({ "name": "  " })))
            .unwrap()
            .is_empty()
    );

    for text in ["first\nsecond", "first\rsecond"] {
        let issues = schema
            .validate(&values(json!({ "name": text })))
            .unwrap_err();
        assert_eq!(issues[0].field.as_deref(), Some("name"));
    }
}
