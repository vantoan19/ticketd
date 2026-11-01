//! Schema-described connector configuration.
//!
//! A connector declares the fields a person can set. ticketd validates values
//! against that declaration, so the desktop and the CLI accept and reject the
//! same input, and neither needs provider-specific code.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Configuration values keyed by schema field.
pub type ConfigValues = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigSchema {
    pub fields: Vec<SchemaField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaField {
    pub key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(flatten)]
    pub kind: FieldKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FieldKind {
    /// One line of text. An empty value means the field is not set.
    Text {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
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
}

/// Where a selector gets its options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChoiceOption {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Built-in syntax checks a field can ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueFormat {
    /// `owner/name`, as in a repository path.
    OwnerName,
    /// A short account handle: letters, digits and single hyphens.
    Handle,
    /// A label or similar tag: no commas or line breaks, at most 50 characters.
    Label,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldIssue {
    pub field: String,
    pub message: String,
}

impl ValueFormat {
    pub(crate) fn is_valid(self, value: &str) -> bool {
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

    /// Checks `raw` against the schema and returns the normalized values:
    /// text trimmed, empty optional fields omitted, selections trimmed and
    /// de-duplicated in order. Every problem is reported, not just the first.
    pub fn validate(&self, raw: &ConfigValues) -> Result<ConfigValues, Vec<FieldIssue>> {
        let mut issues = Vec::new();
        let mut values = ConfigValues::new();
        for key in raw.keys() {
            if self.field(key).is_none() {
                issues.push(issue(key, "is not a setting of this source"));
            }
        }
        for field in &self.fields {
            let before = issues.len();
            let normalized = field.normalize(raw.get(&field.key), &mut issues);
            if issues.len() > before {
                continue;
            }
            match normalized {
                Some(value) => {
                    values.insert(field.key.clone(), value);
                }
                None if field.required => issues.push(issue(&field.key, "is required")),
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
        let mut issues = Vec::new();
        let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for assignment in assignments {
            match assignment.split_once('=') {
                Some((key, value)) if !key.trim().is_empty() => grouped
                    .entry(key.trim().to_owned())
                    .or_default()
                    .push(value.to_owned()),
                _ => issues.push(issue(assignment, "expected key=value")),
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
                Some(FieldKind::Text { .. }) if entries.len() > 1 => {
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
    fn normalize(&self, raw: Option<&Value>, issues: &mut Vec<FieldIssue>) -> Option<Value> {
        let raw = raw.filter(|value| !value.is_null());
        match &self.kind {
            FieldKind::Text { format, .. } => {
                let text = match raw {
                    None => return None,
                    Some(Value::String(text)) => text.trim(),
                    Some(_) => {
                        issues.push(issue(&self.key, "must be text"));
                        return None;
                    }
                };
                if text.is_empty() {
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
                    None => return None,
                    Some(Value::Array(list)) => list,
                    Some(_) => {
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
        }
    }
}

fn issue(field: &str, message: impl Into<String>) -> FieldIssue {
    FieldIssue {
        field: field.to_owned(),
        message: message.into(),
    }
}
