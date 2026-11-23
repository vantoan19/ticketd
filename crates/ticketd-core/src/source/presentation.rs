//! Provider-supplied display data, interpreted by ticketd's own clients.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{ConnectorDescriptor, Surface};

/// The schema and presentation for a source registered with the engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceDescription {
    #[serde(flatten)]
    pub descriptor: ConnectorDescriptor,
    pub presentation: SourcePresentation,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SourcePresentation {
    pub icon_svg: Option<String>,
    pub issue_name: IssueName,
    pub sign_in: SignInGuidance,
    pub fields: BTreeMap<String, FieldPresentation>,
    pub target: Option<TargetPresentation>,
    pub discovery_note: Option<String>,
    pub pull_request_link: Option<PullRequestLink>,
    pub hosts: Vec<String>,
}

/// The last occurrence of the separator ends the place. The separator is
/// included in the displayed number when it is part of the issue's name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct IssueName {
    pub separator: String,
    pub separator_in_number: bool,
    /// A place separator to surround with spaces in the human-readable label.
    pub place_separator: Option<String>,
}

impl IssueName {
    pub(crate) fn parts(&self, locator: &str, display: &str) -> (String, String) {
        if self.separator.is_empty() {
            return (String::new(), display.to_owned());
        }
        locator.rsplit_once(&self.separator).map_or_else(
            || (locator.to_owned(), String::new()),
            |(place, number)| {
                let number = if self.separator_in_number && !number.is_empty() {
                    format!("{}{number}", self.separator)
                } else {
                    number.to_owned()
                };
                (place.to_owned(), number)
            },
        )
    }

    pub(crate) fn preview_label(&self, locator: &str, display: &str) -> String {
        let Some(separator) = self
            .place_separator
            .as_deref()
            .filter(|separator| !separator.is_empty())
        else {
            return display.to_owned();
        };
        let (place, number) = self.parts(locator, display);
        let short_place = place
            .rsplit_once(separator)
            .map_or(place.as_str(), |(_, tail)| tail);
        let between = if self.separator_in_number || number.is_empty() {
            ""
        } else {
            &self.separator
        };
        format!("{short_place}{between}{number}")
    }

    pub(crate) fn place_label(&self, place: &str) -> String {
        match self
            .place_separator
            .as_deref()
            .filter(|separator| !separator.is_empty())
        {
            Some(separator) => place.replacen(separator, &format!(" {separator} "), 1),
            None => place.to_owned(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SignInGuidance {
    pub terminal_hint: Option<String>,
    pub desktop_hint: Option<String>,
    /// The complete instruction for the connection screen.
    pub desktop_instruction: Option<String>,
}

impl SignInGuidance {
    pub fn hint(&self, surface: Surface) -> Option<&str> {
        match surface {
            Surface::Terminal => self.terminal_hint.as_deref(),
            Surface::Desktop => self.desktop_hint.as_deref(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FieldPresentation {
    pub placeholder: Option<String>,
    pub additional_placeholder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetPresentation {
    pub field: String,
    pub label: String,
    pub example: String,
    pub choose: String,
    pub add: String,
}

/// How to recognize an evidence link with the path /owner/project/segment/number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestLink {
    pub host: String,
    pub segment: String,
}

/// One piece of the human-readable configuration summary. Clients render
/// ordinary text with optional emphasis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryPart {
    pub text: String,
    pub emphasis: bool,
}
