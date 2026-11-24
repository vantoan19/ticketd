//! Schema-described connector configuration.
//!
//! A connector declares the fields a person can set. ticketd validates values
//! against that declaration, so the desktop and the CLI accept and reject the
//! same input, and neither needs provider-specific code.

use std::collections::{BTreeMap, HashSet};

use regex::Regex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Configuration values keyed by schema field.
pub type ConfigValues = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ConfigSchema {
    pub fields: Vec<SchemaField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SchemaField {
    pub key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<FieldPattern>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub advanced: bool,
    /// An input key that must have a value for this setting to apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_if: Option<String>,
    #[serde(flatten)]
    pub kind: FieldKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FieldKind {
    /// One line of text. An empty value means the field is not set.
    Text {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        format: Option<ValueFormat>,
    },
    /// An ordered set of values picked from options and, when allowed, typed.
    MultiSelect {
        options: OptionSource,
        /// Whether a value that is not among the offered options is accepted.
        #[serde(default)]
        allow_custom: bool,
        #[serde(default)]
        min_items: usize,
        max_items: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        format: Option<ValueFormat>,
    },
    /// An informational link. Its URL is metadata rather than a setting value.
    Link { url: String },
    /// An opaque credential sent only in connection requests.
    Secret,
}

/// A regular expression and instructions for correcting a mismatched value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FieldPattern {
    pub regex: String,
    pub message: String,
}

/// Where a selector gets its options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum OptionSource {
    Static {
        options: Vec<ChoiceOption>,
    },
    /// Options come from the connector while the person types. `depends_on`
    /// names fields whose current values the connector needs.
    Dynamic {
        #[serde(default)]
        depends_on: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ChoiceOption {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Built-in syntax checks a field can ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ValueFormat {
    /// `owner/name`, as in a repository path.
    OwnerName,
    /// A short account handle: letters, digits and single hyphens.
    Handle,
    /// A label or similar tag: no commas or line breaks, at most 50 characters.
    Label,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FieldIssue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub message: String,
}

impl FieldIssue {
    pub fn for_field(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            field: Some(field.into()),
            message: message.into(),
        }
    }

    pub fn for_form(message: impl Into<String>) -> Self {
        Self {
            field: None,
            message: message.into(),
        }
    }
}

impl ValueFormat {
    pub fn is_valid(self, value: &str) -> bool {
        self.check(value).is_ok()
    }

    fn check(self, value: &str) -> Result<(), &'static str> {
        match self {
            Self::OwnerName => {
                let valid_part = |part: &str| {
                    !part.is_empty()
                        && part.len() <= 100
                        && part
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
                };
                match value.split_once('/') {
                    Some((owner, name)) if valid_part(owner) && valid_part(name) => Ok(()),
                    _ => Err("must look like owner/name"),
                }
            }
            Self::Handle => {
                let valid = !value.is_empty()
                    && value.len() <= 39
                    && !value.starts_with('-')
                    && !value.ends_with('-')
                    && !value.contains("--")
                    && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
                if valid {
                    Ok(())
                } else {
                    Err("must be a username of letters, digits and hyphens")
                }
            }
            Self::Label => {
                if value.chars().count() <= 50 && !value.contains([',', '\n', '\r']) {
                    Ok(())
                } else {
                    Err("must be at most 50 characters without commas or line breaks")
                }
            }
        }
    }
}

impl ConfigSchema {
    pub fn field(&self, key: &str) -> Option<&SchemaField> {
        self.fields.iter().find(|field| field.key == key)
    }

    /// Checks that this schema can be used, even when no values are supplied.
    pub fn check_definition(&self) -> Result<(), Vec<FieldIssue>> {
        let mut issues = Vec::new();
        let mut keys = HashSet::new();
        let mut secret_env_keys = HashSet::new();
        for field in &self.fields {
            if field.key.trim().is_empty() || !keys.insert(field.key.as_str()) {
                issues.push(issue(&field.key, "has a blank or repeated setting key"));
            }
            if let Some(pattern) = &field.pattern
                && Regex::new(&pattern.regex).is_err()
            {
                issues.push(issue(&field.key, "has an invalid validation pattern"));
            }
            if let FieldKind::MultiSelect {
                min_items,
                max_items,
                ..
            } = &field.kind
                && min_items > max_items
            {
                issues.push(issue(&field.key, "has a minimum greater than its maximum"));
            }
            if matches!(field.kind, FieldKind::Secret) {
                let key = env_part(&field.key);
                if !secret_env_keys.insert(format!("{key}_COMMAND")) || !secret_env_keys.insert(key)
                {
                    issues.push(issue(
                        &field.key,
                        "shares a credential environment variable with another field",
                    ));
                }
            }
            let mut seen = HashSet::from([field.key.as_str()]);
            let mut current = field;
            while let Some(dependency) = &current.show_if {
                if !seen.insert(dependency) {
                    issues.push(issue(&field.key, "has a circular show_if condition"));
                    break;
                }
                match self.field(dependency) {
                    Some(parent) if !matches!(parent.kind, FieldKind::Link { .. }) => {
                        current = parent
                    }
                    _ => {
                        issues.push(issue(
                            &field.key,
                            "has a show_if condition without a matching input",
                        ));
                        break;
                    }
                }
            }
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }

    pub fn is_active(&self, field: &SchemaField, raw: &ConfigValues) -> bool {
        let mut current = field;
        let mut seen = HashSet::from([field.key.as_str()]);
        while let Some(dependency) = &current.show_if {
            if !seen.insert(dependency.as_str()) || !raw.get(dependency).is_some_and(has_value) {
                return false;
            }
            let Some(parent) = self.field(dependency) else {
                return false;
            };
            current = parent;
        }
        true
    }

    /// Checks `raw` against the schema and returns the normalized values:
    /// text trimmed, empty optional fields omitted, selections trimmed and
    /// de-duplicated in order. Every problem is reported, not just the first.
    pub fn validate(&self, raw: &ConfigValues) -> Result<ConfigValues, Vec<FieldIssue>> {
        self.validate_settings(raw, true)
    }

    /// Checks supplied settings and required credentials before discovery is configured.
    pub fn validate_connection_draft(
        &self,
        raw: &ConfigValues,
    ) -> Result<ConfigValues, Vec<FieldIssue>> {
        self.validate_settings(raw, false)
    }

    fn validate_settings(
        &self,
        raw: &ConfigValues,
        require_complete: bool,
    ) -> Result<ConfigValues, Vec<FieldIssue>> {
        self.check_definition()?;
        let mut issues = Vec::new();
        let mut values = ConfigValues::new();
        for key in raw.keys() {
            if self.field(key).is_none() {
                issues.push(issue(key, "is not a setting of this source"));
            }
        }
        for field in &self.fields {
            if matches!(field.kind, FieldKind::Link { .. }) {
                if raw.contains_key(&field.key) {
                    issues.push(issue(&field.key, "is a link and does not take a value"));
                }
                continue;
            }
            if !self.is_active(field, raw) {
                continue;
            }
            let before = issues.len();
            let normalized = field.normalize(raw.get(&field.key), &mut issues);
            if issues.len() > before {
                continue;
            }
            match normalized {
                Some(value) => {
                    values.insert(field.key.clone(), value);
                }
                None if field.required
                    && (require_complete || matches!(field.kind, FieldKind::Secret)) =>
                {
                    issues.push(issue(
                        &field.key,
                        // A selection holds several values; its label is plural.
                        if matches!(field.kind, FieldKind::MultiSelect { .. }) {
                            "are required"
                        } else {
                            "is required"
                        },
                    ))
                }
                None => {}
            }
        }
        if issues.is_empty() {
            Ok(values)
        } else {
            Err(issues)
        }
    }

    /// Builds raw values from `key=value` assignments, as the CLI receives
    /// them. A repeated key, or a comma-separated value, fills a selection.
    pub fn values_from_assignments(
        &self,
        assignments: &[String],
    ) -> Result<ConfigValues, Vec<FieldIssue>> {
        self.check_definition()?;
        let mut issues = Vec::new();
        let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for assignment in assignments {
            match assignment.split_once('=') {
                Some((key, value)) if !key.trim().is_empty() => grouped
                    .entry(key.trim().to_owned())
                    .or_default()
                    .push(value.to_owned()),
                _ => issues.push(FieldIssue::for_form("expected a key=value assignment")),
            }
        }
        let mut values = ConfigValues::new();
        for (key, entries) in grouped {
            match self.field(&key).map(|field| &field.kind) {
                Some(FieldKind::MultiSelect { .. }) => {
                    let items = entries
                        .iter()
                        .flat_map(|entry| entry.split(','))
                        .map(|item| Value::String(item.to_owned()))
                        .collect();
                    values.insert(key, Value::Array(items));
                }
                Some(FieldKind::Link { .. }) => {
                    issues.push(issue(&key, "is a link and does not take a value"));
                }
                Some(FieldKind::Text { .. } | FieldKind::Secret) if entries.len() > 1 => {
                    issues.push(issue(&key, "was given more than once"));
                }
                _ => {
                    let entry = entries.into_iter().next().unwrap_or_default();
                    values.insert(key, Value::String(entry));
                }
            }
        }
        if issues.is_empty() {
            Ok(values)
        } else {
            Err(issues)
        }
    }
}

impl SchemaField {
    pub fn check_secret_pattern(&self, value: &str) -> Result<(), FieldIssue> {
        let Some(pattern) = &self.pattern else {
            return Ok(());
        };
        let message = match Regex::new(&pattern.regex) {
            Ok(regex) if regex.is_match(value) => return Ok(()),
            Ok(_) => pattern.message.as_str(),
            Err(_) => "has an invalid validation pattern in this source's schema",
        };
        Err(issue(&self.key, message))
    }

    fn normalize(&self, raw: Option<&Value>, issues: &mut Vec<FieldIssue>) -> Option<Value> {
        let raw = raw.filter(|value| !value.is_null())?;
        let pattern = match self
            .pattern
            .as_ref()
            .map(|pattern| Regex::new(&pattern.regex))
            .transpose()
        {
            Ok(pattern) => pattern,
            Err(_) => {
                issues.push(issue(&self.key, "has an invalid validation pattern"));
                return None;
            }
        };
        let matches_pattern = |value: &str| {
            pattern
                .as_ref()
                .is_none_or(|pattern| pattern.is_match(value))
        };
        let pattern_message = || {
            self.pattern
                .as_ref()
                .map_or("does not match the expected format", |pattern| {
                    pattern.message.as_str()
                })
        };
        match &self.kind {
            FieldKind::Text { format, .. } => {
                let text = match raw {
                    Value::String(text) => text.trim(),
                    _ => {
                        issues.push(issue(&self.key, "must be text"));
                        return None;
                    }
                };
                if text.is_empty() {
                    return None;
                }
                if text.contains(['\r', '\n']) {
                    issues.push(issue(&self.key, "must be a single line"));
                    return None;
                }
                if text.chars().count() > 200 {
                    issues.push(issue(&self.key, "must be at most 200 characters"));
                    return None;
                }
                if let Some(format) = format
                    && let Err(message) = format.check(text)
                {
                    issues.push(issue(&self.key, message));
                    return None;
                }
                if !matches_pattern(text) {
                    issues.push(issue(&self.key, pattern_message()));
                    return None;
                }
                Some(Value::String(text.to_owned()))
            }
            FieldKind::MultiSelect {
                options,
                allow_custom,
                min_items,
                max_items,
                format,
            } => {
                let list = match raw {
                    Value::Array(list) => list,
                    _ => {
                        issues.push(issue(&self.key, "must be a list"));
                        return None;
                    }
                };
                let mut items: Vec<String> = Vec::new();
                for entry in list {
                    let Value::String(text) = entry else {
                        issues.push(issue(&self.key, "must contain only text"));
                        return None;
                    };
                    let text = text.trim();
                    if !text.is_empty() && !items.iter().any(|item| item == text) {
                        items.push(text.to_owned());
                    }
                }
                if items.is_empty() {
                    return None;
                }
                for item in &items {
                    if !matches_pattern(item) {
                        issues.push(issue(&self.key, format!("'{item}' {}", pattern_message())));
                    }
                    if let Some(format) = format
                        && let Err(message) = format.check(item)
                    {
                        issues.push(issue(&self.key, format!("'{item}' {message}")));
                    }
                    if let (false, OptionSource::Static { options }) = (allow_custom, options)
                        && !options.iter().any(|option| option.value == *item)
                    {
                        issues.push(issue(
                            &self.key,
                            format!("'{item}' is not an available choice"),
                        ));
                    }
                }
                if items.len() < *min_items {
                    issues.push(issue(&self.key, format!("needs at least {min_items}")));
                }
                if items.len() > *max_items {
                    issues.push(issue(&self.key, format!("allows at most {max_items}")));
                }
                Some(Value::Array(items.into_iter().map(Value::String).collect()))
            }
            FieldKind::Secret => {
                let Some(secret) = raw.as_str() else {
                    issues.push(issue(&self.key, "must be a credential string"));
                    return None;
                };
                if secret.trim().is_empty() {
                    return None;
                }
                if secret.len() > VALUE_LIMIT {
                    issues.push(issue(&self.key, "must be at most 64 KiB"));
                } else if !matches_pattern(secret) {
                    issues.push(issue(&self.key, pattern_message()));
                } else {
                    return Some(raw.clone());
                }
                None
            }
            FieldKind::Link { .. } => None,
        }
    }
}

fn issue(field: &str, message: impl Into<String>) -> FieldIssue {
    FieldIssue::for_field(field, message)
}

pub fn has_value(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => items
            .iter()
            .any(|item| item.as_str().is_some_and(|text| !text.trim().is_empty())),
        _ => false,
    }
}

#[doc(hidden)]
pub const VALUE_LIMIT: usize = 64 * 1024;

#[doc(hidden)]
pub fn env_part(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}
